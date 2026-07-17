import { spawn } from "child_process";
import { writeFile, readFile, unlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { connectDB, Website, IndexingQueue, ExecutionLog, Settings } from "@/lib/mongodb";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_URLS_PER_WEBSITE = 100000;
const SITEMAP_CONCURRENCY  = 8;
const REDIRECT_CONCURRENCY = 20;

// ─── helpers ─────────────────────────────────────────────────────────────────

const pythonBin = process.env.PYTHON_EXECUTABLE || "python3";
const scriptsDir = join(process.cwd(), "scripts", "python");

function runScript(pythonFile: string, args: string[]): Promise<{ output: string; exitCode: number }> {
  return new Promise((resolve) => {
    const scriptPath = join(scriptsDir, pythonFile);
    const proc = spawn(pythonBin, [scriptPath, ...args], {
      env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
    });
    let output = "";
    proc.stdout.on("data", (d: Buffer) => { output += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { output += d.toString(); });
    proc.on("error", (err) => resolve({ output: err.message, exitCode: -1 }));
    proc.on("close", (code) => resolve({ output, exitCode: code ?? 0 }));
  });
}

async function cleanupFiles(paths: string[]) {
  await Promise.allSettled(paths.map((p) => unlink(p)));
}

async function parseTxtFile(path: string): Promise<string[]> {
  const text = await readFile(path, "utf-8");
  return text.split("\n").map((l) => l.trim()).filter(Boolean);
}

async function parseGscResultCsv(path: string): Promise<{ url: string; success: boolean; error: string }[]> {
  const text = await readFile(path, "utf-8");
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  return lines.slice(1).map((l) => {
    const parts  = l.split(",");
    const url    = parts[0]?.replace(/^"|"$/g, "").trim() ?? "";
    const result = parts.slice(2).join(",").replace(/^"|"$/g, "").trim();
    const success = result === "Indexed Successfully";
    return { url, success, error: success ? "" : result };
  });
}

async function parseBingResultCsv(path: string): Promise<{ url: string; success: boolean; error: string }[]> {
  const text = await readFile(path, "utf-8");
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  return lines.slice(1).map((l) => {
    const parts  = l.split(",");
    const url    = parts[0]?.replace(/^"|"$/g, "").trim() ?? "";
    const status = parts[1]?.replace(/^"|"$/g, "").trim() ?? "";
    const success = status === "Submitted";
    return { url, success, error: success ? "" : status };
  });
}

// Node.js sitemap URL extractor — parallel, no Python needed
async function extractPageUrls(
  sitemapUrl: string,
  maxUrls: number
): Promise<{ urls: string[]; log: string }> {
  const collected: string[] = [];
  let log = "";

  async function fetchXml(url: string): Promise<string | null> {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; ASAPBot/1.0)" },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return null;
      const text = await res.text();
      if (text.trimStart().startsWith("<!DOCTYPE") || text.trimStart().startsWith("<html")) return null;
      return text;
    } catch {
      return null;
    }
  }

  async function processSitemap(url: string, depth: number): Promise<void> {
    if (collected.length >= maxUrls || depth > 4) return;
    const xml = await fetchXml(url);
    if (!xml) return;

    const isSitemapIndex =
      xml.includes("<sitemapindex") ||
      (xml.includes("<sitemap>") && xml.includes("<loc>") && !xml.includes("<urlset"));

    if (isSitemapIndex) {
      const childUrls: string[] = [];
      const blocks = xml.match(/<sitemap>[\s\S]*?<\/sitemap>/g) ?? [];
      for (const block of blocks) {
        const m = block.match(/<loc>\s*([^<]+)\s*<\/loc>/);
        if (m) childUrls.push(m[1].trim());
      }
      log += `\n  [index] ${url} → ${childUrls.length} child sitemaps`;
      for (let i = 0; i < childUrls.length; i += SITEMAP_CONCURRENCY) {
        if (collected.length >= maxUrls) break;
        await Promise.all(
          childUrls.slice(i, i + SITEMAP_CONCURRENCY).map((u) => processSitemap(u, depth + 1))
        );
      }
    } else {
      const blocks = xml.match(/<url>[\s\S]*?<\/url>/g) ?? [];
      for (const block of blocks) {
        if (collected.length >= maxUrls) break;
        const m = block.match(/<loc>\s*([^<]+)\s*<\/loc>/);
        if (m) collected.push(m[1].trim());
      }
      log += `\n  [sitemap] ${url} → ${blocks.length} URLs`;
    }
  }

  await processSitemap(sitemapUrl, 0);
  return { urls: collected, log };
}

// Follow 301/302 redirects and return the final canonical URL
async function resolveRedirect(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ASAPBot/1.0)" },
    });
    return res.url || url;
  } catch {
    return url;
  }
}

// Save one per-step execution log immediately after the step completes
async function saveStepLog({
  scriptSlug,
  scriptName,
  websiteId,
  websiteName,
  output,
  status,
  exitCode,
  startedAt,
}: {
  scriptSlug:  string;
  scriptName:  string;
  websiteId:   string;
  websiteName: string;
  output:      string;
  status:      "success" | "error";
  exitCode:    number;
  startedAt:   Date;
}) {
  const completedAt = new Date();
  try {
    await ExecutionLog.collection.insertOne({
      userId:      null,
      userEmail:   "system",
      userName:    "Automated",
      scriptSlug,
      scriptName,
      inputs:      { websiteId, websiteName },
      output:      output.trim(),
      status,
      exitCode,
      startedAt,
      completedAt,
      durationMs:  completedAt.getTime() - startedAt.getTime(),
      isAutomated: true,
      websiteId,
      websiteName,
    });
  } catch (err) {
    console.error(`[LOG ERROR] ${websiteName}/${scriptSlug}: ${err}`);
  }
}

// ─── per-website processor ────────────────────────────────────────────────────

type SettingsDoc = { serviceAccounts: { name: string; json: string }[] } | null;

async function processWebsite(
  website: Record<string, unknown>,
  settings: SettingsDoc,
  results: { websiteId: string; name: string; steps: string[] }[]
) {
  const websiteId   = (website._id as { toString(): string }).toString();
  const websiteName = website.name as string;

  console.log(`\n[AUTOMATION] ═══ ${websiteName} ═══`);

  const automationStartDate = (website.automationStartDate as Date | null) ?? null;
  if (automationStartDate && automationStartDate > new Date()) {
    console.log(`[AUTOMATION] Skipping — start date not reached`);
    results.push({ websiteId, name: websiteName, steps: [`⏳ Scheduled for ${automationStartDate.toISOString()}`] });
    return;
  }

  const gscAccountName   = (website.gscServiceAccountName as string) ?? "";
  const bingApiKey       = (website.bingApiKey as string) ?? "";
  const siteUrl          = (website.url as string) ?? "";
  const robotsTxtUrl     = (
    (website.robotsTxtUrl as string) ||
    (siteUrl ? `${siteUrl.replace(/\/$/, "")}/robots.txt` : "")
  ).replace(/([^:])\/\/+/g, "$1/");
  const existingSitemaps = (website.sitemaps as { url: string }[]) ?? [];

  const tempFiles: string[] = [];
  const steps: string[] = [];

  try {
    // ── Pre-check: count pending URLs to decide what to run ───────────────
    let [gscPending, bingPending] = await Promise.all([
      IndexingQueue.countDocuments({ websiteId, gscStatus:  "pending" }),
      IndexingQueue.countDocuments({ websiteId, bingStatus: "pending" }),
    ]);

    const needsRefill = gscPending < 10000 || bingPending < 50000;
    console.log(`[AUTOMATION] ${websiteName}: GSC=${gscPending} Bing=${bingPending} pending | refill=${needsRefill}`);

    // ── Steps 1+2: Sitemap Discovery + URL Extraction (only when low) ─────
    if (needsRefill) {
      // Step 1: Sitemap Discovery
      const step1Start = new Date();
      let sitemapUrls: string[] = existingSitemaps.map((s) => s.url);
      let step1Output = "";
      let step1Status: "success" | "error" = "success";
      let step1ExitCode = 0;

      try {
        if (sitemapUrls.length > 0) {
          step1Output = `Using ${sitemapUrls.length} saved sitemap(s):\n\n${sitemapUrls.join("\n")}`;
          console.log(`[STEP 1] ${websiteName}: using ${sitemapUrls.length} saved sitemap(s)`);
        } else if (!robotsTxtUrl) {
          step1Output   = "No robots.txt URL configured.";
          step1Status   = "error";
          step1ExitCode = 1;
        } else {
          console.log(`[STEP 1] ${websiteName}: fetching ${robotsTxtUrl}`);
          const sitemapOutputFile = join(tmpdir(), `asap_auto_sitemaps_${websiteId}_${randomUUID()}.txt`);
          tempFiles.push(sitemapOutputFile);

          const { output, exitCode } = await runScript("sitemap_scraper.py", [
            "--robots_urls", robotsTxtUrl,
            "--output_file", sitemapOutputFile,
          ]);
          step1Output   = output;
          step1ExitCode = exitCode;

          if (exitCode === 0) {
            const discovered = await parseTxtFile(sitemapOutputFile).catch(() => []);
            sitemapUrls = discovered;
            step1Output += `\n\nResult: ${sitemapUrls.length} sitemap(s) discovered.`;
            if (sitemapUrls.length > 0) {
              const mongoose = await import("mongoose");
              await Website.collection.updateOne(
                { _id: new mongoose.default.Types.ObjectId(websiteId) },
                { $set: { sitemaps: sitemapUrls.map((url) => ({ url, discoveredAt: new Date() })) } }
              );
            } else {
              step1Status = "error";
            }
          } else {
            step1Status = "error";
          }
        }
      } catch (err) {
        step1Output  += `\nException: ${err}`;
        step1Status   = "error";
        step1ExitCode = -1;
      }

      await saveStepLog({
        scriptSlug: "automation-sitemap-discovery", scriptName: "Sitemap Discovery",
        websiteId, websiteName, output: step1Output,
        status: step1Status, exitCode: step1ExitCode, startedAt: step1Start,
      });
      steps.push(step1Status === "success" ? `✓ Step 1: ${sitemapUrls.length} sitemap(s)` : "✗ Step 1 failed");

      // Step 2: URL Extraction
      const step2Start = new Date();
      let step2Output = "";
      let step2Status: "success" | "error" = "success";
      let newUrlsAdded = 0;

      try {
        if (sitemapUrls.length === 0) {
          step2Output = "No sitemaps — skipping extraction.";
          step2Status = "error";
        } else {
          console.log(`[STEP 2] ${websiteName}: extracting from ${sitemapUrls.length} sitemap(s)`);
          let extractLog = `Extracting from ${sitemapUrls.length} sitemap(s) (max ${MAX_URLS_PER_WEBSITE}):\n`;

          for (const sitemapUrl of sitemapUrls) {
            if (newUrlsAdded >= MAX_URLS_PER_WEBSITE) break;
            const { urls, log } = await extractPageUrls(sitemapUrl, MAX_URLS_PER_WEBSITE - newUrlsAdded);
            extractLog += `\n${sitemapUrl}:${log}\n  → ${urls.length} page URLs`;

            for (const url of urls) {
              try {
                const res = await IndexingQueue.updateOne(
                  { websiteId, url },
                  { $setOnInsert: { websiteId, url, discoveredAt: new Date(), gscStatus: "pending", bingStatus: "pending" } },
                  { upsert: true }
                );
                if (res.upsertedCount > 0) newUrlsAdded++;
              } catch { /* duplicate */ }
            }
          }
          step2Output = `${extractLog}\n\nResult: ${newUrlsAdded} new URLs added.`;
          console.log(`[STEP 2] ${websiteName}: ${newUrlsAdded} new URLs added`);
        }
      } catch (err) {
        step2Output += `\nException: ${err}`;
        step2Status  = "error";
      }

      await saveStepLog({
        scriptSlug: "automation-url-extraction", scriptName: "URL Extraction",
        websiteId, websiteName, output: step2Output,
        status: step2Status, exitCode: step2Status === "success" ? 0 : 1, startedAt: step2Start,
      });
      steps.push(step2Status === "success" ? `✓ Step 2: ${newUrlsAdded} new URLs` : "✗ Step 2 failed");

      // Re-count after refill
      [gscPending, bingPending] = await Promise.all([
        IndexingQueue.countDocuments({ websiteId, gscStatus:  "pending" }),
        IndexingQueue.countDocuments({ websiteId, bingStatus: "pending" }),
      ]);
    }

    // ── Step 3: GSC Indexing — only if >= 191 pending ─────────────────────
    const step3Start = new Date();
    let step3Output = "";
    let step3Status: "success" | "error" = "success";
    let step3ExitCode = 0;

    try {
      if (gscPending === 0) {
        step3Output = "No pending URLs for GSC — skipping.";
        console.log(`[STEP 3] ${websiteName}: skipped — 0 pending`);
      } else {
        const serviceAccount = settings?.serviceAccounts.find((a) => a.name === gscAccountName);
        if (!serviceAccount) {
          step3Output   = gscAccountName ? `Service account "${gscAccountName}" not found.` : "No GSC service account configured.";
          step3Status   = "error";
          step3ExitCode = 1;
        } else {
          const gscLimit   = Math.min(gscPending, Math.floor(Math.random() * 10) + 191);
          const pendingGsc = await IndexingQueue.find({ websiteId, gscStatus: "pending" }).limit(gscLimit).lean();
          console.log(`[STEP 3] ${websiteName}: resolving redirects for ${pendingGsc.length} URLs…`);

          // Resolve 301 redirects — get canonical URL for each before submitting to GSC
          type Resolved = { q: (typeof pendingGsc)[0]; canonical: string };
          const resolvedBatch: Resolved[] = [];
          for (let i = 0; i < pendingGsc.length; i += REDIRECT_CONCURRENCY) {
            const chunk = pendingGsc.slice(i, i + REDIRECT_CONCURRENCY);
            const resolved = await Promise.all(
              chunk.map(async (q) => ({ q, canonical: await resolveRedirect(q.url) }))
            );
            resolvedBatch.push(...resolved);
          }
          const redirected = resolvedBatch.filter((r) => r.canonical !== r.q.url).length;
          console.log(`[STEP 3] ${websiteName}: submitting ${resolvedBatch.length} URLs to GSC (${redirected} redirects resolved)`);

          const saFile = join(tmpdir(), `asap_auto_sa_${websiteId}_${randomUUID()}.json`);
          const inCsv  = join(tmpdir(), `asap_auto_gsc_in_${websiteId}_${randomUUID()}.csv`);
          const outCsv = join(tmpdir(), `asap_auto_gsc_out_${websiteId}_${randomUUID()}.csv`);
          tempFiles.push(saFile, inCsv, outCsv);

          await writeFile(saFile, serviceAccount.json);
          await writeFile(inCsv, "url\n" + resolvedBatch.map((r) => r.canonical).join("\n"));

          const { output, exitCode } = await runScript("url_indexer.py", [
            "--service_account_file", saFile, "--csv_file", inCsv, "--output_file", outCsv,
          ]);
          step3Output   = output;
          step3ExitCode = exitCode;

          if (exitCode === 0) {
            const gscResults = await parseGscResultCsv(outCsv).catch(() => []);
            const resultMap  = new Map(gscResults.map((r) => [r.url, r]));
            let gscOk = 0, gscFail = 0;
            for (const { q, canonical } of resolvedBatch) {
              const r = resultMap.get(canonical);
              if (r?.success) {
                // Also update stored URL to canonical
                await IndexingQueue.updateOne({ _id: q._id }, { $set: { url: canonical, gscStatus: "submitted", gscSubmittedAt: new Date(), gscError: null } });
                gscOk++;
              } else {
                await IndexingQueue.updateOne({ _id: q._id }, { $set: { gscStatus: "failed", gscError: r?.error ?? "Unknown" } });
                gscFail++;
              }
            }
            step3Output += `\n\nResult: ${gscOk} submitted, ${gscFail} failed (${redirected} redirects resolved, limit ${gscLimit}).`;
            console.log(`[STEP 3] ${websiteName}: GSC ${gscOk} ok, ${gscFail} failed`);
          } else {
            step3Status = "error";
            await IndexingQueue.updateMany({ _id: { $in: pendingGsc.map((q) => q._id) } }, { $set: { gscStatus: "failed", gscError: `Script exited ${exitCode}` } });
          }
        }
      }
    } catch (err) {
      step3Output  += `\nException: ${err}`;
      step3Status   = "error";
      step3ExitCode = -1;
    }

    await saveStepLog({
      scriptSlug: "automation-gsc-indexing", scriptName: "GSC Indexing",
      websiteId, websiteName, output: step3Output,
      status: step3Status, exitCode: step3ExitCode, startedAt: step3Start,
    });
    steps.push(step3Status === "success" ? "✓ Step 3: GSC done" : "✗ Step 3: GSC failed");

    // ── Step 4: Bing Indexing — only if >= 9500 pending ───────────────────
    const step4Start = new Date();
    let step4Output = "";
    let step4Status: "success" | "error" = "success";
    let step4ExitCode = 0;

    try {
      if (bingPending === 0) {
        step4Output = "No pending URLs for Bing — skipping.";
        console.log(`[STEP 4] ${websiteName}: skipped — 0 pending`);
      } else {
        const bingLimit   = Math.min(bingPending, Math.floor(Math.random() * 501) + 9500);
        const pendingBing = await IndexingQueue.find({ websiteId, bingStatus: "pending" }).limit(bingLimit).lean();
        console.log(`[STEP 4] ${websiteName}: submitting ${pendingBing.length} URLs to Bing (limit ${bingLimit})`);

        const bingInFile  = join(tmpdir(), `asap_auto_bing_in_${websiteId}_${randomUUID()}.txt`);
        const bingOutFile = join(tmpdir(), `asap_auto_bing_out_${websiteId}_${randomUUID()}.csv`);
        tempFiles.push(bingInFile, bingOutFile);

        await writeFile(bingInFile, pendingBing.map((q) => q.url).join("\n"));
        const bingArgs = ["--urls", bingInFile, "--output_file", bingOutFile];
        if (bingApiKey) bingArgs.push("--api_key", bingApiKey);

        const { output, exitCode } = await runScript("bing_indexnow.py", bingArgs);
        step4Output   = output;
        step4ExitCode = exitCode;

        if (exitCode === 0) {
          const bingResults = await parseBingResultCsv(bingOutFile).catch(() => []);
          const resultMap   = new Map(bingResults.map((r) => [r.url, r]));
          let bingOk = 0, bingFail = 0;
          for (const q of pendingBing) {
            const r = resultMap.get(q.url);
            if (r?.success) {
              await IndexingQueue.updateOne({ _id: q._id }, { $set: { bingStatus: "submitted", bingSubmittedAt: new Date(), bingError: null } });
              bingOk++;
            } else {
              await IndexingQueue.updateOne({ _id: q._id }, { $set: { bingStatus: "failed", bingError: r?.error ?? "Unknown" } });
              bingFail++;
            }
          }
          step4Output += `\n\nResult: ${bingOk} submitted, ${bingFail} failed (limit ${bingLimit}).`;
          console.log(`[STEP 4] ${websiteName}: Bing ${bingOk} ok, ${bingFail} failed`);
        } else {
          step4Status = "error";
          await IndexingQueue.updateMany({ _id: { $in: pendingBing.map((q) => q._id) } }, { $set: { bingStatus: "failed", bingError: `Script exited ${exitCode}` } });
        }
      }
    } catch (err) {
      step4Output  += `\nException: ${err}`;
      step4Status   = "error";
      step4ExitCode = -1;
    }

    await saveStepLog({
      scriptSlug: "automation-bing-indexing", scriptName: "Bing Indexing",
      websiteId, websiteName, output: step4Output,
      status: step4Status, exitCode: step4ExitCode, startedAt: step4Start,
    });
    steps.push(step4Status === "success" ? "✓ Step 4: Bing done" : "✗ Step 4: Bing failed");

  } finally {
    await cleanupFiles(tempFiles);
  }

  console.log(`[AUTOMATION] ${websiteName}: ${steps.join(" | ")}`);
  results.push({ websiteId, name: websiteName, steps });
}

// ─── automation runner (runs fully in background after HTTP response) ─────────

const WEBSITE_CONCURRENCY = 20;

async function runAutomation() {
  await connectDB();

  // ── Prune old execution logs (keep last 15 days) ──────────────────────────
  const cutoff = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
  const { deletedCount } = await ExecutionLog.deleteMany({ startedAt: { $lt: cutoff } });
  if (deletedCount > 0) console.log(`[AUTOMATION] Pruned ${deletedCount} execution log(s) older than 15 days`);

  const allWebsites = await Website.find({}).lean();
  const websites    = allWebsites.filter(
    (w) => !!(w as unknown as Record<string, unknown>).automationEnabled
  );

  if (websites.length === 0) {
    console.log("[AUTOMATION] No automation-enabled websites.");
    return;
  }

  const settings = await Settings.findOne({ singleton: true }).lean();
  const results: { websiteId: string; name: string; steps: string[] }[] = [];

  console.log(`[AUTOMATION] Starting — ${websites.length} websites, ${WEBSITE_CONCURRENCY} at a time`);

  for (let i = 0; i < websites.length; i += WEBSITE_CONCURRENCY) {
    const batch = websites.slice(i, i + WEBSITE_CONCURRENCY);
    const batchNum = Math.floor(i / WEBSITE_CONCURRENCY) + 1;
    const totalBatches = Math.ceil(websites.length / WEBSITE_CONCURRENCY);
    console.log(`[AUTOMATION] Batch ${batchNum}/${totalBatches}: ${batch.map((w) => w.name).join(", ")}`);

    await Promise.allSettled(
      batch.map((w) => processWebsite(w as unknown as Record<string, unknown>, settings, results))
    );
  }

  console.log(`\n[AUTOMATION] Done. ${results.length} website(s) processed.`);
}

// ─── route ───────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const authHeader = req.headers.get("Authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Respond immediately — automation runs fully in background
  // This prevents client disconnect from aborting the job
  setTimeout(() => {
    runAutomation().catch((err) => console.error("[AUTOMATION] Fatal:", err));
  }, 0);

  return Response.json({ message: "Automation started in background" });
}
