import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readFile } from "fs/promises";
import { tmpdir } from "os";
import { resolve, sep } from "path";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const { searchParams } = new URL(req.url);
  const rawPath = searchParams.get("path");
  if (!rawPath) return new Response("Missing path", { status: 400 });

  // Resolve both paths and ensure the file is inside tmpdir (prevents path traversal)
  const resolvedPath = resolve(rawPath);
  const allowedRoot = resolve(tmpdir());

  if (!resolvedPath.startsWith(allowedRoot + sep) && resolvedPath !== allowedRoot) {
    return new Response("Forbidden", { status: 403 });
  }

  let fileBuffer: Buffer;
  try {
    fileBuffer = await readFile(resolvedPath);
  } catch {
    return new Response("File not found or already deleted", { status: 404 });
  }

  const filename = resolvedPath.split(sep).pop() ?? "output";
  const ext = filename.split(".").pop()?.toLowerCase();
  const contentType =
    ext === "txt" ? "text/plain; charset=utf-8"
    : ext === "zip" ? "application/zip"
    : "text/csv; charset=utf-8";

  return new Response(new Uint8Array(fileBuffer), {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
