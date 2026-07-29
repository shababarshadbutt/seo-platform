// Drive the Cleaner's SFTP endpoint and record the wall-clock time of every
// stage transition from the SSE frames — the client-side view of the same data
// the new server log line records.
const domain = process.argv[2] ?? "bench2264";
const t0 = Date.now();
const res = await fetch("http://localhost:3011/api/cleaner/process-sftp", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ domain, site_url: `https://${domain}.com` })
});
if (!res.ok) { console.error("HTTP", res.status, await res.text()); process.exit(1); }
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
const stageFirst = new Map(), stageLast = new Map(), counts = new Map();
let lastStage = null, lastAt = t0;
const totals = new Map();
let summary = null, errored = null;
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf("\n\n")) >= 0) {
    const frame = buf.slice(0, i); buf = buf.slice(i + 2);
    if (!frame.startsWith("data: ")) continue;
    let ev; try { ev = JSON.parse(frame.slice(6)); } catch { continue; }
    const at = Date.now();
    const stage = ev.stage ?? (ev.type === "done" ? "done" : ev.type === "error" ? "error" : null);
    if (stage) {
      if (lastStage) totals.set(lastStage, (totals.get(lastStage) ?? 0) + (at - lastAt));
      if (!stageFirst.has(stage)) stageFirst.set(stage, at - t0);
      stageLast.set(stage, at - t0);
      counts.set(stage, (counts.get(stage) ?? 0) + 1);
      lastStage = stage; lastAt = at;
    }
    if (ev.type === "done") summary = ev.summary;
    if (ev.type === "error") errored = ev.message;
  }
}
if (lastStage) totals.set(lastStage, (totals.get(lastStage) ?? 0) + (Date.now() - lastAt));
const total = Date.now() - t0;
console.log(`\nTOTAL ${(total/1000).toFixed(1)}s` + (errored ? `  ERROR: ${errored}` : ""));
console.log("stage       frames    elapsed_s   share   first_seen_s");
for (const [stage, ms] of [...totals].sort((a,b)=>b[1]-a[1])) {
  console.log(
    `${stage.padEnd(10)}  ${String(counts.get(stage)).padStart(6)}  ${(ms/1000).toFixed(1).padStart(10)}  ${((ms/total)*100).toFixed(1).padStart(5)}%  ${(stageFirst.get(stage)/1000).toFixed(1).padStart(12)}`
  );
}
if (summary) console.log(`\nfiles_processed=${summary.files_processed} kept=${summary.files_kept} urls_kept_files=${summary.total_urls_kept_files} clean_remaining=${summary.clean_urls_remaining} dupes=${summary.duplicates_removed}`);
