import { spawn } from "child_process";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { randomUUID } from "crypto";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, ExecutionLog, Settings } from "@/lib/mongodb";
import { getScriptBySlug } from "@/lib/scripts-config";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 minutes

// `File` is only a global in Node.js 20+. On Node 18 (common on AWS) it is
// undefined, so `instanceof File` throws. Use duck-typing instead.
function isUploadedFile(value: unknown): value is File {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as File).arrayBuffer === "function" &&
    typeof (value as File).size === "number" &&
    (value as File).size > 0
  );
}

function sseEvent(data: object): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

function sseError(message: string): Response {
  const body =
    `data: ${JSON.stringify({ type: "output", line: message })}\n\n` +
    `data: ${JSON.stringify({ type: "done", exitCode: -1, outputFilePath: null })}\n\n`;
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

export async function POST(req: Request) {
  try {
    return await _handle(req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[run route] Unhandled error:", err);
    return new Response(msg || "Unknown server error", { status: 500 });
  }
}

async function _handle(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return new Response("Unauthorized", { status: 401 });

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return new Response("Invalid form data", { status: 400 });
  }

  const slug = formData.get("slug") as string;
  const script = getScriptBySlug(slug);
  if (!script) return new Response("Script not found", { status: 404 });

  // Process inputs — save uploaded files to temp dir
  const resolvedInputs: Record<string, string> = {};
  const tempFiles: string[] = [];

  for (const inputDef of script.inputs) {
    if (inputDef.folder) {
      // Folder inputs arrive as a single pre-parsed JSON blob (client-side XML parsing)
      const value = formData.get(inputDef.name);
      if (isUploadedFile(value)) {
        const tempPath = join(tmpdir(), `asap_${Date.now()}_${inputDef.name}.json`);
        await writeFile(tempPath, Buffer.from(await value.arrayBuffer()));
        tempFiles.push(tempPath);
        resolvedInputs[inputDef.name] = tempPath;
      }
    } else {
      const value = formData.get(inputDef.name);
      if (isUploadedFile(value)) {
        const originalExt = value.name.includes(".")
          ? value.name.slice(value.name.lastIndexOf("."))
          : ".bin";
        const tempPath = join(tmpdir(), `asap_${Date.now()}_${inputDef.name}${originalExt}`);
        await writeFile(tempPath, Buffer.from(await value.arrayBuffer()));
        tempFiles.push(tempPath);
        resolvedInputs[inputDef.name] = tempPath;
      } else if (typeof value === "string" && value.trim()) {
        const str = value.trim();
        // Large text inputs hit OS ENAMETOOLONG when passed as CLI args —
        // write to a temp file and pass the path instead.
        const slugsWithLargeTextInput = ["bing-indexnow", "sitemap-deleter"];
        if (slugsWithLargeTextInput.includes(slug) && str.length > 8000) {
          const tempPath = join(tmpdir(), `asap_${Date.now()}_${inputDef.name}.txt`);
          await writeFile(tempPath, str);
          tempFiles.push(tempPath);
          resolvedInputs[inputDef.name] = tempPath;
        } else {
          resolvedInputs[inputDef.name] = str;
        }
      }
    }
  }

  await connectDB();

  // Service account — fetch from DB and write to temp file
  if (script.requiresServiceAccount) {
    const selectedName = (formData.get("serviceAccountName") as string)?.trim();
    if (!selectedName) {
      return sseError("[ERROR] No service account selected. Please choose one from the dropdown.");
    }

    const settings = await Settings.findOne({ singleton: true }).lean();
    const account = settings?.serviceAccounts.find((a) => a.name === selectedName);

    if (!account) {
      return sseError(
        `[ERROR] Service account "${selectedName}" not found. Go to Settings to add it.`
      );
    }

    const saPath = join(tmpdir(), `asap_sa_${Date.now()}.json`);
    await writeFile(saPath, account.json);
    tempFiles.push(saPath); // SA JSON is deleted after run
    resolvedInputs["service_account_file"] = saPath;
  }

  // Scripts that produce a downloadable output file
  let outputFilePath: string | null = null;
  if (slug === "url-indexer") {
    outputFilePath = join(tmpdir(), `indexing_log_${randomUUID()}.csv`);
    resolvedInputs["output_file"] = outputFilePath;
  } else if (slug === "sitemap-scraper") {
    outputFilePath = join(tmpdir(), `sitemaps_${randomUUID()}.txt`);
    resolvedInputs["output_file"] = outputFilePath;
  } else if (slug === "url-extractor") {
    outputFilePath = join(tmpdir(), `extracted_urls_${randomUUID()}.csv`);
    resolvedInputs["output_file"] = outputFilePath;
  } else if (slug === "duplicate-sitemap-remover") {
    outputFilePath = join(tmpdir(), `clean_sitemaps_${randomUUID()}.zip`);
    resolvedInputs["output_file"] = outputFilePath;
  } else if (slug === "bing-indexnow") {
    outputFilePath = join(tmpdir(), `bing_indexnow_${randomUUID()}.csv`);
    resolvedInputs["output_file"] = outputFilePath;
  }

  // Create execution log
  const log = await ExecutionLog.create({
    userId: session.user.id,
    userEmail: session.user.email!,
    userName: session.user.name!,
    scriptSlug: slug,
    scriptName: script.name,
    inputs: Object.fromEntries(
      Object.entries(resolvedInputs).filter(([, v]) => !v.startsWith(resolve(tmpdir())))
    ),
    status: "running",
    startedAt: new Date(),
  });

  // Build CLI args
  const pythonBin = process.env.PYTHON_EXECUTABLE || "python3";
  const scriptPath = join(process.cwd(), "scripts", "python", script.pythonFile);
  const spawnArgs: string[] = [scriptPath];

  for (const [key, value] of Object.entries(resolvedInputs)) {
    spawnArgs.push(`--${key}`, value);
  }

  // SSE stream
  const capturedOutputFilePath = outputFilePath;

  const stream = new ReadableStream({
    start(controller) {
      const enqueue = (data: object) => controller.enqueue(sseEvent(data));

      let outputBuffer = "";
      const startTime = Date.now();

      const proc = spawn(pythonBin, spawnArgs, {
        env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
      });

      const handleOutput = (chunk: Buffer) => {
        const text = chunk.toString();
        outputBuffer += text;
        for (const raw of text.split("\n")) {
          const line = raw.replace(/\r/g, "");
          if (line.trim()) enqueue({ type: "output", line });
        }
      };

      proc.stdout.on("data", handleOutput);
      proc.stderr.on("data", handleOutput);

      proc.on("error", async (err) => {
        const durationMs = Date.now() - startTime;
        const message = err.message.includes("ENOENT")
          ? `Python executable not found: "${pythonBin}". Set PYTHON_EXECUTABLE in .env.local.`
          : err.message;

        enqueue({ type: "output", line: `[ERROR] ${message}` });
        await ExecutionLog.findByIdAndUpdate(log._id, {
          output: message, status: "error", exitCode: -1,
          completedAt: new Date(), durationMs,
        });
        enqueue({ type: "done", exitCode: -1, logId: log._id.toString(), outputFilePath: null });
        controller.close();
        await cleanupTempFiles(tempFiles);
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
          outputFilePath: exitCode === 0 ? capturedOutputFilePath : null,
        });
        controller.close();
        await cleanupTempFiles(tempFiles);
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


async function cleanupTempFiles(paths: string[]) {
  await Promise.allSettled(paths.map((p) => unlink(p)));
}
