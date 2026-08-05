// Run the stale-artifact sweep on demand against UPLOAD_DIR and print what it did.
// The periodic job calls the same function; this is for verifying a real volume
// (or a reproduction) without waiting for the daily tick.
import { sweepStaleArtifacts } from "../src/sitemaps/staleArtifactSweep.js";

const uploadDir = process.env.UPLOAD_DIR;

if (!uploadDir) {
  process.stderr.write("set UPLOAD_DIR\n");
  process.exit(1);
}

const logger = {
  info: (o: unknown, m?: string) => console.log("[info]", m, JSON.stringify(o)),
  warn: (o: unknown, m?: string) => console.log("[warn]", m, JSON.stringify(o)),
  error: (o: unknown, m?: string) => console.log("[error]", m, JSON.stringify(o))
} as never;

const result = await sweepStaleArtifacts(uploadDir, logger);

console.log("RESULT " + JSON.stringify(result));
