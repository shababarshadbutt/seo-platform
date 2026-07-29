// PATH B: kill the client mid-transfer and DO NOT reconnect. The run must be
// stopped after the abandon grace period and its SFTP slot actually released.
//
// Backend must run with CLEANER_ABANDON_GRACE_MINUTES=1 (the configurable floor)
// so this observes the real timeout rather than a mocked one.
const B = "http://localhost:3011";
const DOMAIN = process.argv[2] ?? "reconnect-test";
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);

async function poolStats() {
  return (await (await fetch(`${B}/api/sftp/domains`)).json()).pool;
}
async function runStatus(runId) {
  const r = await fetch(`${B}/api/cleaner/runs/${runId}`);
  return r.ok ? await r.json() : { status: `HTTP_${r.status}` };
}

console.log("=== PATH B: abandon without reconnecting ===\n");

const ac = new AbortController();
const res = await fetch(`${B}/api/cleaner/process-sftp`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ domain: DOMAIN, site_url: `https://${DOMAIN}.com` }),
  signal: ac.signal
});
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
let runId = null;
let killedAt = null;

outer: while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf("\n\n")) >= 0) {
    const raw = buf.slice(0, i); buf = buf.slice(i + 2);
    const line = raw.split("\n").find((l) => l.startsWith("data:"));
    if (!line) continue;
    let f; try { f = JSON.parse(line.slice(5).trim()); } catch { continue; }
    if (f.type === "started") runId = f.run_id;
    if (f.type === "progress" && (f.current ?? 0) >= 10) {
      killedAt = f.current;
      ac.abort();
      break outer;
    }
  }
}

check("run started and client aborted mid-transfer", Boolean(runId) && killedAt > 0,
  `run_id=${runId} killed at ${killedAt}`);

await sleep(2000);
const poolWhileAbandoned = await poolStats();
const statusEarly = await runStatus(runId);
console.log(`  [${stamp()}] after abort: status=${statusEarly.status} watchers=${statusEarly.watchers} pool=${poolWhileAbandoned.available}/${poolWhileAbandoned.limit}`);
check("watchers drops to 0 once the client is gone", statusEarly.watchers === 0,
  `watchers=${statusEarly.watchers}`);
check("run is still running immediately after the disconnect (not aborted early)",
  statusEarly.status === "running", `status=${statusEarly.status}`);

let reaped = false;
let reapedAt = null;
const startedWaiting = Date.now();

for (let i = 0; i < 40; i += 1) {
  await sleep(5000);
  const s = await runStatus(runId);
  const p = await poolStats();
  const elapsed = Math.round((Date.now() - startedWaiting) / 1000);
  console.log(`  [${stamp()}] +${elapsed}s status=${s.status} pool_available=${p.available}/${p.limit} last=${s.last?.current ?? "-"}`);

  if (s.status !== "running") {
    reaped = true;
    reapedAt = elapsed;
    break;
  }
}

check("run is stopped after the abandon grace period", reaped,
  reaped ? `status changed after ~${reapedAt}s (grace=60s)` : "still running after 200s");

let released = false;
let releasedAt = null;

for (let i = 0; i < 12; i += 1) {
  const p = await poolStats();

  if (p.available === p.limit) {
    released = true;
    releasedAt = i * 5;
    break;
  }

  await sleep(5000);
}

const finalPool = await poolStats();
check("SFTP slots are RELEASED, not held for the rest of the run", released,
  `available=${finalPool.available}/${finalPool.limit}${released ? ` within ~${releasedAt}s of the stop` : " — STILL HELD"}`);

const finalStatus = await runStatus(runId);
check("the stopped run did not silently report success",
  finalStatus.status === "abandoned" || finalStatus.status === "HTTP_404",
  `status=${finalStatus.status}`);

const filesPulled = finalStatus.last?.current ?? 0;
check("the run stopped EARLY rather than completing the whole set",
  filesPulled > 0 && filesPulled < 500,
  `stopped after ${filesPulled} files`);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
