// PATH A: kill the client mid-transfer, confirm the run keeps going server-side
// and that a reconnect sees LIVE progress rather than a failure.
const B = "http://localhost:3011";
const DOMAIN = "reconnect-test";
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = "init";
const at = (s) => { step = s; console.log(`  [step] ${s}`); };
// Hard watchdog: a hang must report WHERE, not just time out the shell.
const watchdog = setTimeout(() => {
  console.log(`
HUNG at step: ${step}`);
  process.exit(2);
}, 240000);
watchdog.unref?.();

async function poolStats() {
  const r = await fetch(`${B}/api/sftp/domains`);
  return (await r.json()).pool;
}
async function runStatus(runId) {
  const r = await fetch(`${B}/api/cleaner/runs/${runId}`);
  return { status: r.status, body: r.ok ? await r.json() : null };
}

// Read SSE frames until `stop(frame)` says to, then abort the connection.
async function readUntil(url, init, stop) {
  const ac = new AbortController();
  const res = await fetch(url, { ...init, signal: ac.signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const frames = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = raw.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let f; try { f = JSON.parse(line.slice(5).trim()); } catch { continue; }
        frames.push(f);
        if (stop(f, frames)) { ac.abort(); return { frames, aborted: true }; }
      }
    }
  } catch (e) {
    if (e.name !== "AbortError") throw e;
  }
  return { frames, aborted: false };
}

console.log("=== PATH A: disconnect mid-transfer, then reconnect ===\n");

// 1. Start the run and hard-kill the connection after ~12 files have landed.
at("A1 start run, read until 12 files");
const first = await readUntil(
  `${B}/api/cleaner/process-sftp`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ domain: DOMAIN, site_url: `https://${DOMAIN}.com` })
  },
  (f) => f.type === "progress" && (f.current ?? 0) >= 12
);

const started = first.frames.find((f) => f.type === "started");
check("run id is delivered before any work frame", Boolean(started?.run_id),
  `run_id=${started?.run_id} (frame #${first.frames.indexOf(started) + 1})`);
const runId = started.run_id;

const lastBefore = [...first.frames].reverse().find((f) => f.type === "progress");
check("client was killed MID-transfer, not at the end", first.aborted && lastBefore.current < lastBefore.total,
  `killed at ${lastBefore.current}/${lastBefore.total}`);

// 2. The run must still be alive with zero watchers.
at("A2 check run survives");
await sleep(1500);
const afterKill = await runStatus(runId);
check("run survives the client disconnect", afterKill.body?.status === "running",
  `status=${afterKill.body?.status} watchers=${afterKill.body?.watchers}`);
check("nobody is watching it", afterKill.body?.watchers === 0,
  `watchers=${afterKill.body?.watchers}`);

// 3. And it must still be making progress — not merely "not dead".
at("A3 check run keeps progressing");
const p1 = (await runStatus(runId)).body?.last?.current ?? 0;
await sleep(4000);
const p2 = (await runStatus(runId)).body?.last?.current ?? 0;
check("run KEEPS WORKING with no client attached", p2 > p1, `progressed ${p1} -> ${p2} while unwatched`);

// 4. Reconnect: must immediately replay live progress, then finish.
at("A4 reconnect and read to terminal");
const reconnected = await readUntil(
  `${B}/api/cleaner/runs/${runId}/progress`,
  {},
  (f) => f.type === "done" || f.type === "error"
);
const replayFirst = reconnected.frames.find((f) => f.type === "progress");
check("reconnect immediately replays current progress (no blank stream)",
  Boolean(replayFirst) && replayFirst.current >= p2,
  `first replayed frame = ${replayFirst?.current}/${replayFirst?.total}`);
const terminal = reconnected.frames.find((f) => f.type === "done" || f.type === "error");
check("reconnected stream reaches a successful terminal frame", terminal?.type === "done",
  `type=${terminal?.type} token=${terminal?.download_token ? "present" : "MISSING"}`);
check("download token survived the disconnect", Boolean(terminal?.download_token),
  `files=${terminal?.summary?.files_processed} urls=${terminal?.summary?.total_urls_kept_files}`);
check("the run completed the FULL file set despite the disconnect",
  terminal?.summary?.files_processed === 120,
  `files_processed=${terminal?.summary?.files_processed} of 120`);

// 5. The ZIP is genuinely downloadable via the token from the reconnected stream.
at("A5 download zip with token");
const dl = await fetch(`${B}/api/cleaner/download/${terminal.download_token}`);
const bytes = dl.ok ? (await dl.arrayBuffer()).byteLength : 0;
check("ZIP downloadable with the token from the RECONNECTED stream", dl.ok && bytes > 0,
  `HTTP ${dl.status}, ${bytes} bytes`);

at("A6 pool released");
const pool = await poolStats();
check("pool fully released after completion", pool.available === pool.limit,
  `available=${pool.available}/${pool.limit}`);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
