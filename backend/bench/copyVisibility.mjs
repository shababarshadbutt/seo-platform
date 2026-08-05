// Deterministic check of the property the atomic-rename fix depends on:
// while a copy is in flight, is a PARTIAL file observable at the destination path?
//
// This beats trying to time a process kill: copyFile on a fast local disk finishes
// hundreds of MB in tens of milliseconds, so a kill lands either before or after
// the copy far more often than during it. Polling the destination's size while the
// copy runs answers the same question deterministically — if any observation sees
// 0 < size < source size, then a crash at that instant leaves exactly that
// truncated file behind.
//
// Usage: node backend/bench/copyVisibility.mjs <sizeMB> [mode]
//   mode "direct" (default) — copyFile straight to the final path (the old way)
//   mode "atomic"           — copyFile to <dest>.part then rename (the fix)
import { copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const SIZE_MB = Number(process.argv[2] ?? 800);
const MODE = process.argv[3] ?? "direct";
const DIR = process.env.COPY_DIR ?? path.join(os.tmpdir(), "copy-visibility");

await rm(DIR, { recursive: true, force: true });
await mkdir(DIR, { recursive: true });

const src = path.join(DIR, "source.bin");
const dest = path.join(DIR, "dest.bin");
const temp = `${dest}.part`;

const chunk = Buffer.alloc(1024 * 1024, 0x78);
const parts = [];
for (let i = 0; i < SIZE_MB; i += 1) parts.push(chunk);
await writeFile(src, Buffer.concat(parts));
const srcSize = (await stat(src)).size;

let partialAtDest = 0;
let partialAtTemp = 0;
let maxPartialSeen = 0;
let observations = 0;
let running = true;

async function sizeOf(p) {
  try {
    return (await stat(p)).size;
  } catch {
    return null;
  }
}

const observer = (async () => {
  while (running) {
    const d = await sizeOf(dest);
    const t = await sizeOf(temp);

    observations += 1;

    if (d !== null && d > 0 && d < srcSize) {
      partialAtDest += 1;
      maxPartialSeen = Math.max(maxPartialSeen, d);
    }
    if (t !== null && t > 0 && t < srcSize) partialAtTemp += 1;
  }
})();

const started = Date.now();
if (MODE === "atomic") {
  await copyFile(src, temp);
  await rename(temp, dest);
} else {
  await copyFile(src, dest);
}
const elapsed = Date.now() - started;
running = false;
await observer;

process.stdout.write(
  JSON.stringify(
    {
      mode: MODE,
      source_mb: SIZE_MB,
      copy_ms: elapsed,
      observations,
      // The headline: was a truncated file ever visible at the REAL path?
      PARTIAL_VISIBLE_AT_REAL_PATH: partialAtDest > 0,
      partial_observations_at_real_path: partialAtDest,
      largest_partial_bytes_at_real_path: maxPartialSeen,
      partial_observations_at_temp_path: partialAtTemp,
      final_dest_bytes: await sizeOf(dest),
      source_bytes: srcSize
    },
    null,
    2
  ) + "\n"
);

await rm(DIR, { recursive: true, force: true });
