import assert from "node:assert/strict";
import { test } from "node:test";

import AdmZip from "adm-zip";

// End-to-end regression test for the v1.42 stale-download bug: complete a
// session (populates the ZIP cache), apply a file edit that RACES the pre-gen
// build, then download and assert the ZIP reflects the edit. Requires the dev
// stack running (docker compose up); skips cleanly when it isn't, so it never
// breaks a plain `npm test` in CI.
//
// The edit is fired the instant the session completes — while the completion
// pre-gen build is still in flight — because that overlap is exactly the race
// that produced stale cached ZIPs. Green on fixed code every run; only the
// broken (pre-fix) code can serve the stale cache and fail here.

const B = process.env.SMOKE_BACKEND ?? "http://localhost:3011";
// Unreachable origin → sampling gets connection-refused fast; we only need the
// files on disk + the edit, not real HTTP results.
const BASE = "http://127.0.0.1:9";
const CATALOG_FILES = 120; // enough that the completion pre-gen is still active
const VICTIM_MARKER = `${BASE}/UNIQUE-VICTIM-MARKER-DO-NOT-KEEP`;

const j = async (p: string, o?: RequestInit) => {
  const r = await fetch(`${B}${p}`, o);
  const t = await r.text();
  try {
    return { status: r.status, body: JSON.parse(t) as any };
  } catch {
    return { status: r.status, body: t as any };
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function reachable() {
  try {
    const r = await fetch(`${B}/health`);
    return r.ok;
  } catch {
    return false;
  }
}
function urlset(locs: string[]) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    locs.map((l) => `  <url><loc>${l}</loc></url>`).join("\n") +
    "\n</urlset>\n"
  );
}
async function downloadCombined(sessionId: string) {
  const r = await fetch(`${B}/api/sessions/${sessionId}/download-sitemaps?type=all`);
  const buf = Buffer.from(await r.arrayBuffer());
  return new AdmZip(buf)
    .getEntries()
    .map((e) => e.getData().toString("utf8"))
    .join("\n");
}

test("cached download reflects an edit that races the pre-gen build", async (t) => {
  if (!(await reachable())) {
    t.skip(`dev stack not reachable at ${B} — skipping integration test`);
    return;
  }

  const created = await j("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "zip-cache-regression", base_url: BASE, sample_size: 5, concurrency: 5 })
  });
  const sid = created.body.session_id as string;
  assert.ok(sid, "session created");

  // Upload catalog files + one victim file with a unique marker loc.
  const form = new FormData();
  for (let i = 0; i < CATALOG_FILES; i += 1) {
    form.append(
      "files",
      new Blob([urlset([`${BASE}/catalog/page-${String(i).padStart(4, "0")}`])], { type: "application/xml" }),
      `catalog-${String(i).padStart(4, "0")}.xml`
    );
  }
  form.append("files", new Blob([urlset([VICTIM_MARKER])], { type: "application/xml" }), "victim.xml");
  const up = await fetch(`${B}/api/sessions/${sid}/upload`, { method: "POST", body: form });
  assert.ok(up.ok, "upload accepted");
  await j(`/api/sessions/${sid}/upload-complete`, { method: "POST" });

  // Poll to COMPLETE, then IMMEDIATELY delete the victim file (inline edit) so
  // its cache-invalidation races the just-started completion pre-gen build.
  let completed = false;
  for (let i = 0; i < 400; i += 1) {
    const s = await j(`/api/sessions/${sid}`);
    const status = s.body.session?.status;
    if (["COMPLETE", "COMPLETED"].includes(status)) {
      const victim = (s.body.sitemap_files ?? []).find((f: any) =>
        String(f.filename).endsWith("victim.xml")
      );
      assert.ok(victim, "victim file present before delete");
      const del = await j(`/api/sessions/${sid}/files/delete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file_ids: [victim.id] })
      });
      assert.ok(del.status >= 200 && del.status < 300, `delete accepted (${del.status})`);
      completed = true;
      break;
    }
    await sleep(150);
  }
  assert.ok(completed, "session reached COMPLETE and edit was fired");

  // Wait for the cache to settle (repopulated after the edit's invalidation),
  // then download the CACHED ZIP and assert the victim is gone.
  let zipReady = false;
  for (let i = 0; i < 60; i += 1) {
    await sleep(1000);
    const s = await j(`/api/sessions/${sid}`);
    if (s.body.session?.zip_ready) {
      zipReady = true;
      break;
    }
  }
  assert.ok(zipReady, "pre-gen cache repopulated after the edit");

  const combined = await downloadCombined(sid);
  assert.ok(combined.includes("/catalog/page-0000"), "kept catalog URLs are present");
  assert.equal(
    combined.includes("UNIQUE-VICTIM-MARKER"),
    false,
    "deleted file's URL must NOT appear in the downloaded ZIP (stale cache bug)"
  );

  await j(`/api/sessions/${sid}`, { method: "DELETE" }).catch(() => {});
});
