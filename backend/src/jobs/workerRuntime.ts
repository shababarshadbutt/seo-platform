import { fileURLToPath } from "node:url";

// Where the piscina worker pools find their worker entrypoints, and whether
// those threads need tsx.
//
// Dev runs the TypeScript sources directly (tsx src/server.ts), so worker
// threads must load ../workers/<name>.ts with `--import tsx`. The production
// image runs a real compiled build (tsc -> dist, node dist/server.js), where
// those same threads must load ../workers/<name>.js and must NOT pull in tsx —
// it isn't a production dependency, and paying a transpile per worker thread on
// a shared box would be pure waste.
//
// Detected from this module's own extension rather than NODE_ENV, so it can
// never disagree with how the process was actually started (a compiled build
// run with NODE_ENV unset still resolves correctly).
const isCompiled = import.meta.url.endsWith(".js");

export function workerFilePath(baseName: string): string {
  return fileURLToPath(
    new URL(
      `../workers/${baseName}.${isCompiled ? "js" : "ts"}`,
      import.meta.url
    )
  );
}

// Empty in a compiled build: the workers are plain JS by then.
export const workerExecArgv: string[] = isCompiled ? [] : ["--import", "tsx"];
