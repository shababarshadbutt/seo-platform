import { writeFile, unlink, readFile, readdir } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { gunzip } from "zlib";
import { promisify } from "util";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, ExecutionLog } from "@/lib/mongodb";

const gunzipAsync = promisify(gunzip);

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function sseEvent(data: object): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

// ── Phase: batch ──────────────────────────────────────────────────────────────
// Receives a parsed batch of sitemaps [{name, urls}] and saves to a temp file.
// Returns a sessionId that the client uses for subsequent batches and the run.

// ── Phase: run ────────────────────────────────────────────────────────────────
// Merges all batch files for the session, runs the Python dedup script,
// streams SSE output, then cleans up temp files.

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return new Response("Unauthorized", { status: 401 });

  let body: {
    phase: "batch" | "run";
    sessionId?: string;
    batchNum?: number;
    sitemaps?: { name: string; urls: string[] }[];
    totalBatches?: number;
  };

  try {
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      // Batch phase — gzip-compressed FormData blob
      const fd = await req.formData();
      const blob = fd.get("data") as Blob | null;
      if (!blob) return new Response("Missing data field", { status: 400 });
      const compressed = Buffer.from(await blob.arrayBuffer());
      const decompressed = await gunzipAsync(compressed);
      body = JSON.parse(decompressed.toString("utf-8"));
    } else {
      // Run phase — plain JSON (small payload)
      body = await req.json();
    }
  } catch {
    return new Response("Invalid request body", { status: 400 });
  }

  const { phase } = body;

  // ── Batch phase ─────────────────────────────────────────────────────────────
  if (phase === "batch") {
    const sessionId = body.sessionId || randomUUID();
    const batchNum = body.batchNum ?? Date.now();
    const batchPath = join(tmpdir(), `asap_dedup_${sessionId}_${batchNum}.json`);
    await writeFile(batchPath, JSON.stringify(body.sitemaps ?? []));
    return Response.json({ sessionId, ok: true });
  }

  // ── Run phase ────────────────────────────────────────────────────────────────
  if (phase === "run") {
    const { sessionId, totalBatches = 0, totalSitemaps = 0 } = body as typeof body & { totalSitemaps?: number };
    if (!sessionId) return new Response("Missing sessionId", { status: 400 });

    const tmpDir = resolve(tmpdir());
    const outputPath = join(tmpDir, `asap_dedup_${sessionId}_output.zip`);
    const mergedPath = join(tmpDir, `asap_dedup_${sessionId}_merged.json`);
    const pythonBin = process.env.PYTHON_EXECUTABLE || "python3";
    const scriptPath = join(process.cwd(), "scripts", "python", "duplicate_sitemap_remover.py");

    // Return SSE headers immediately so Cloudflare doesn't time out while we
    // merge batch files and spin up the Python process.
    const stream = new ReadableStream({
      async start(controller) {
        const enqueue = (data: object) => controller.enqueue(sseEvent(data));
        const startTime = Date.now();

        // ── Merge batch files ───────────────────────────────────────────────
        enqueue({ type: "output", line: "[INFO] Merging uploaded batches..." });

        const allFiles = (await readdir(tmpDir)).filter(
          (f) => f.startsWith(`asap_dedup_${sessionId}_`) && f.endsWith(".json")
        );

        if (allFiles.length === 0) {
          enqueue({ type: "output", line: "[ERROR] No batch data found for this session." });
          enqueue({ type: "done", exitCode: -1, outputFilePath: null });
          controller.close();
          return;
        }

        // Concatenate JSON arrays at string level — avoids parsing URL data
        // in Node.js and keeps memory usage low regardless of sitemap size.
        const parts: string[] = [];
        for (const f of allFiles) {
          const content = (await readFile(join(tmpDir, f), "utf8")).trim();
          if (content.length <= 2) continue; // empty array "[]"
          const inner = content.slice(1, -1).trim();
          if (inner) parts.push(inner);
        }
        await writeFile(mergedPath, "[" + parts.join(",") + "]");

        enqueue({ type: "output", line: `[INFO] Merged ${totalSitemaps} sitemaps from ${allFiles.length} batches` });

        const tempToClean = [...allFiles.map((f) => join(tmpDir, f)), mergedPath];

        // ── Log to MongoDB ──────────────────────────────────────────────────
        await connectDB();
        const log = await ExecutionLog.create({
          userId: session.user.id,
          userEmail: session.user.email!,
          userName: session.user.name!,
          scriptSlug: "duplicate-sitemap-remover",
          scriptName: "Duplicate Sitemap Remover",
          inputs: { sitemaps: totalSitemaps, batches: totalBatches },
          status: "running",
          startedAt: new Date(),
        });

        // ── Spawn Python ────────────────────────────────────────────────────
        let outputBuffer = "";

        const proc = spawn(pythonBin, [
          scriptPath,
          "--sitemap_files", mergedPath,
          "--output_file", outputPath,
        ], {
          env: { ...process.env, PYTHONUNBUFFERED: "1" },
        });

        const handleOutput = (chunk: Buffer) => {
          const text = chunk.toString();
          outputBuffer += text;
          for (const line of text.split("\n")) {
            if (line.trim()) enqueue({ type: "output", line });
          }
        };

        proc.stdout.on("data", handleOutput);
        proc.stderr.on("data", handleOutput);

        proc.on("error", async (err) => {
          const durationMs = Date.now() - startTime;
          enqueue({ type: "output", line: `[ERROR] ${err.message}` });
          await ExecutionLog.findByIdAndUpdate(log._id, {
            output: err.message, status: "error", exitCode: -1,
            completedAt: new Date(), durationMs,
          });
          enqueue({ type: "done", exitCode: -1, logId: log._id.toString(), outputFilePath: null });
          controller.close();
          await Promise.allSettled(tempToClean.map((p) => unlink(p)));
        });

        proc.on("close", async (exitCode) => {
          const durationMs = Date.now() - startTime;
          const status = exitCode === 0 ? "success" : "error";
          await ExecutionLog.findByIdAndUpdate(log._id, {
            output: outputBuffer, status, exitCode,
            completedAt: new Date(), durationMs,
          });
          enqueue({
            type: "done",
            exitCode: exitCode ?? -1,
            logId: log._id.toString(),
            outputFilePath: exitCode === 0 ? outputPath : null,
          });
          controller.close();
          await Promise.allSettled(tempToClean.map((p) => unlink(p)));
        });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  }

  return new Response("Invalid phase", { status: 400 });
}
