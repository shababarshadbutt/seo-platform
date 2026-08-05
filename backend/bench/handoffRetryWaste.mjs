// Does retrying the Cleaner->Migration handoff redo work that already succeeded?
//
// Direct evidence, not inference. The instrument matters here: mtime does NOT work
// — fs.copyFile on Windows copies the SOURCE's timestamps to the destination, so a
// re-copied file keeps its old mtime and the metric reports a false "nothing was
// redone" (verified before writing this). Instead, append a MARKER to every stored
// file after the first ingest: a re-copy overwrites the file from the pristine
// source and the marker vanishes; a skip leaves it. That is filesystem-independent.
//
// Also reports each run's elapsed time, the job's own `ingested` count (files that
// completed copy + insert), and sitemap_files row counts, which must not grow —
// createStoredSitemapFile is idempotent per (session_id, filename) and
// buildStoredUploadFilename is deterministic (no random token).
//
// Usage: node backend/bench/handoffRetryWaste.mjs <fileCount> [urlsPerFile]
import { appendFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const FILES = Number(process.argv[2] ?? 800);
const URLS = Number(process.argv[3] ?? 50);
const BACKEND = process.env.BENCH_BACKEND ?? "http://localhost:3011";
const UPLOAD_DIR = process.env.UPLOAD_DIR;
const DOMAIN = "retry-audit.example.com";

if (!UPLOAD_DIR) {
  throw new Error("set UPLOAD_DIR so this can stat the stored files");
}

const seconds = (ms) => (ms / 1000).toFixed(1);

function urlset(i) {
  const urls = [];
  for (let u = 0; u < URLS; u += 1) {
    urls.push(`  <url><loc>https://${DOMAIN}/p/${i}/${u}</loc></url>`);
  }
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.join("\n") +
    "\n</urlset>\n"
  );
}

async function readSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let last = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (line) last = JSON.parse(line.slice(6));
    }
  }
  return last;
}

async function clean() {
  const form = new FormData();
  form.set("domain", `https://${DOMAIN}`);
  form.set("subfolder", "sitemaps");
  form.set("fileCount", String(FILES));
  for (let i = 0; i < FILES; i += 1) {
    form.append(
      "files",
      new Blob([urlset(i)], { type: "application/xml" }),
      `sitemap-${String(i).padStart(5, "0")}.xml`
    );
  }
  const r = await fetch(`${BACKEND}/api/cleaner/process`, { method: "POST", body: form });
  if (!r.ok) throw new Error(`clean failed ${r.status}: ${await r.text()}`);
  const done = await readSse(r);
  if (!done?.download_token) throw new Error(`no token: ${JSON.stringify(done)}`);
  return done.download_token;
}

async function createSession() {
  const r = await fetch(`${BACKEND}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: `retry-audit-${FILES}`,
      base_url: `https://${DOMAIN}`,
      sample_size: 5
    })
  });
  const b = await r.json();
  if (!b.session_id) throw new Error(`no session: ${JSON.stringify(b)}`);
  return b.session_id;
}

const MARKER = "<!-- RETRY-AUDIT-MARKER -->";

function storedFiles(sessionId) {
  const prefix = `${sessionId}-`;
  return readdirSync(UPLOAD_DIR).filter((name) => {
    if (!name.startsWith(prefix)) return false;
    try {
      return statSync(path.join(UPLOAD_DIR, name)).isFile();
    } catch {
      return false;
    }
  });
}

// Stamp every stored file. A re-copy from the pristine source erases the stamp.
function stampAll(names) {
  for (const name of names) {
    appendFileSync(path.join(UPLOAD_DIR, name), MARKER);
  }
  return names.length;
}

function countStamped(names) {
  let kept = 0;
  for (const name of names) {
    try {
      if (readFileSync(path.join(UPLOAD_DIR, name), "utf8").includes(MARKER)) kept += 1;
    } catch {}
  }
  return kept;
}

async function handoff(sessionId, token, label) {
  const started = Date.now();
  const r = await fetch(`${BACKEND}/api/sessions/${sessionId}/sources/cleaner`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token })
  });
  const body = await r.json();
  if (r.status !== 202) {
    process.stdout.write(`${label}: HTTP ${r.status} ${JSON.stringify(body)}\n`);
    return null;
  }
  for (let i = 0; i < 600; i += 1) {
    await new Promise((res) => setTimeout(res, 1000));
    const s = await (await fetch(`${BACKEND}/api/sessions/${sessionId}/sources/cleaner/status`)).json();
    if (s.status === "COMPLETE" || s.status === "FAILED") {
      process.stdout.write(
        `${label}: ${s.status} in ${seconds(Date.now() - started)}s  result=${JSON.stringify(
          s.result ?? s.error ?? null
        )}\n`
      );
      return { seconds: Number(seconds(Date.now() - started)), status: s.status };
    }
  }
  process.stdout.write(`${label}: TIMED OUT\n`);
  return null;
}

async function rowCount(sessionId) {
  const r = await fetch(`${BACKEND}/api/sessions/${sessionId}`);
  const b = await r.json();
  return Array.isArray(b.sitemap_files) ? b.sitemap_files.length : null;
}

const token = await clean();
const sessionId = await createSession();
process.stdout.write(`session=${sessionId}\n`);

const first = await handoff(sessionId, token, "run 1 (initial)");
const names = storedFiles(sessionId);
const stamped = stampAll(names);
const rows1 = await rowCount(sessionId);

// The retry: same session, same token — exactly what a user pressing the button
// again after a perceived failure produces.
const second = await handoff(sessionId, token, "run 2 (retry)");
const survivors = countStamped(names);
const rows2 = await rowCount(sessionId);

process.stdout.write(
  JSON.stringify(
    {
      files_in_corpus: FILES,
      stored_files: names.length,
      stamped_after_run1: stamped,
      run1_seconds: first?.seconds ?? null,
      run2_retry_seconds: second?.seconds ?? null,
      // The headline: a stamp erased means that file was copied AGAIN.
      RE_COPIED_on_retry: stamped - survivors,
      SKIPPED_on_retry: survivors,
      sitemap_files_rows_after_run1: rows1,
      sitemap_files_rows_after_retry: rows2,
      duplicate_rows_created: rows1 !== null && rows2 !== null ? rows2 - rows1 : null
    },
    null,
    2
  ) + "\n"
);
process.stdout.write(`\nsession_id=${sessionId}\n`);
