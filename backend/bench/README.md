# Retry / crash-recovery audits

`handoffRetryWaste.mjs` answers whether retrying the Cleaner handoff redoes work
that already succeeded. **The instrument matters:** mtime is useless here —
`fs.copyFile` on Windows copies the SOURCE's timestamps to the destination, so a
re-copied file keeps its old mtime and you get a false "nothing was redone". It
stamps a marker into every stored file after run 1 instead; a re-copy from the
pristine source erases the stamp, a skip leaves it.

```sh
UPLOAD_DIR=<real dir> node backend/bench/handoffRetryWaste.mjs 800 50
```

Measured before the resume fix: retry re-copied **801/801** files in the same 6.2s.
After: **0** re-copied, 801 skipped, 1.1s. With a partially-complete first attempt
(100 rows+files removed, 50 files removed but rows kept) it copies exactly those
150 and skips 651 — the row-exists-but-file-missing case must NOT skip, or you get
a row pointing at nothing.

`patternJobCrashRecovery.ts` answers what BullMQ does when the worker dies
mid-transform. Timers are shortened (lockDuration 6s vs production's 60 min) so the
stalled-job path is observable in seconds; the semantics don't depend on the values.

```sh
npx tsx bench/patternJobCrashRecovery.ts crash <sessionId> <patternId>   # dies at ~10 files
npx tsx bench/patternJobCrashRecovery.ts recover                          # watches the re-run
```

Result: BullMQ re-runs the same job and correctly redoes ALL files, because the
crashed attempt committed nothing (`pattern_transforms` = 0 rows, no
`sitemap_files.filename` moved — the transaction died with the connection).
`pattern_structure_jobs.files_done` is a progress indicator, NOT a resume cursor —
see the long comment in `jobs/patternStructureJob.ts` before considering a resume
there. Note stalled recovery is independent of `attempts: 1`, which only suppresses
retries after a *reported* failure.

# Cleaner -> Migration handoff ingest

Two scripts, because the interesting number and the interesting wiring cannot be
measured by the same run.

`cleanerHandoffIngest.mjs` drives the REAL flow — clean N generated sitemaps,
create a session, POST the handoff — and reports what the handoff returned and how
long it took. `--proxy` sends the handoff through the frontend's `/api/backend`
proxy instead of straight at the backend, which is the distinction that matters:

**The backend has no handler timeout at all.** Measured on Fastify 4.29 / Node 24,
`server.timeout` and `server.requestTimeout` are both `0` (Fastify pins
requestTimeout back to 0 even though Node 18+ defaults it to 300s). Nothing
server-side aborts a slow request. The 300s wall is **undici's `headersTimeout`
inside the Next proxy's `fetch`**, which throws `TypeError: fetch failed`
(`cause: UND_ERR_HEADERS_TIMEOUT`) — and the proxy puts that bare "fetch failed"
in its 502 body, which is what reaches the user. `undici-timeout-probe`-style
check, if you need to re-confirm it: hold a request open with no response and
fetch it; it gives up at ~305s.

```sh
node backend/bench/cleanerHandoffIngest.mjs 4000 150 --proxy --poll
```

`ingestRate.ts` isolates the ingest loop and times the OLD sequential version
against the NEW bounded-concurrency one over the same corpus. It exists because
the Cleaner will not accept a corpus big enough to make the ingest slow on a fast
local disk — its dedup budget is sized by URL **bytes**, and refuses with "too
large to deduplicate in memory", while the ingest cost is per **file**.

```sh
npx tsx bench/ingestRate.ts 25000 40    # <fileCount> [kbPerFile]
```

It prints `files_to_exceed_proxy_timeout` for both paths: the file count at which a
single synchronous request would cross 300s at the measured per-file rate. Note
that per-file cost here is dominated by the DB round trip, not bytes — 1MB files
measured the same as 40KB — so this number is very sensitive to how far away
Postgres is. On a laptop with Postgres in local Docker it takes ~22,000 files; the
production report was 2,700, i.e. ~8x slower per file.

# Pattern rename / transform at scale

`seedLargeSession.ts` creates a session with N sitemap files of M URLs each, wired
up the way extraction leaves them (`sitemap_files`, one `patterns` row,
`pattern_file_occurrences`, a bounded sample), so the pattern rename / structure
transform / transform-undo endpoints can be driven at real scale.

It exists because those three ran synchronously inside the HTTP request and timed
out client-side at 823 files. **Per-file URL count is the variable that matters**,
and sizing a repro by file count alone actively misleads: 900 files x 500 URLs
transformed in 17s, while 823 files x 8000 URLs took 136s. They are background jobs
as of migration 037; use this to reproduce or to A/B a change to the rewrite path.

```sh
# 823 files x 8000 URLs — ~960MB on disk, the size that broke the old path
npx tsx bench/seedLargeSession.ts 823 8000
# prints {session_id, pattern_id, files}; then drive
#   POST /api/sessions/:id/patterns/:patternId/transform      (202 + job_id)
#   GET  /api/sessions/:id/patterns/:patternId/structure-job  (poll progress)
```

Needs `DATABASE_URL` and a real `UPLOAD_DIR` (it writes the files itself). It
writes hundreds of MB — delete the session and its `$UPLOAD_DIR/<session-id>-*`
files afterwards, or the concurrency-1 ZIP pre-gen queue will spend minutes
building archives for it and stall `sessionZipCache.integration.test.ts` into a
failure that looks like a real regression.

`patterns.template` uses a literal `{param}` per variable segment; only the
transform *structure* syntax uses named `{A}`/`{B}` tokens. Mixing them up gives
"current structure defines 2 params but the pattern has 0".

# Cleaner SFTP stage timing

`cleaner-sftp-stage-timing.mjs` drives `POST /api/cleaner/process-sftp` and
reports elapsed wall-clock per SSE stage — `pull`, `parse`, `dedup`, `output`,
`index`, `zip`, `done` — plus frame counts and each stage's first-seen offset.

It exists because a real run took ~25 minutes for 2,264 files against a
250-file/500k-URL benchmark that finished in ~19s, and nothing on the server
recorded where the time went: the stage names were only ever written to the
browser. `sitemaps/stageTimer.ts` now logs the same breakdown server-side on
every run (`"cleaner run timing"`, leading with `dominant_stage`), so in
production you should read the log line first and only reach for this script to
reproduce or to A/B a change.

## Usage

```sh
node backend/bench/cleaner-sftp-stage-timing.mjs <sftp-domain-folder>
```

Expects a backend on `localhost:3011` with SFTP configured — see
`frontend/e2e/README.md` for the full local stack, including the two env traps
(`UPLOAD_DIR`/`EXPORT_DIR` default to container paths).

## Generating a comparable corpus

Per-file URL count matters as much as file count: `pull` cost is per FILE
(each download is its own SSH connect + fastGet + end) while `parse`/`dedup`
scale with URLs. A benchmark that varies only one of them will mislead.

```python
import os, random
random.seed(7)
d = "sftp/bench2264"; os.makedirs(d, exist_ok=True)
for i in range(2264):
    n = random.choice([200]*6 + [800]*3 + [2000]*2 + [5000])   # ~2.29M URLs total
    with open(f"{d}/sitemap-{i:05d}.xml", "w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n')
        for j in range(n):
            f.write(f"  <url><loc>https://bench2264.com/c{i}/p{j}</loc><lastmod>2026-07-01</lastmod></url>\n")
        f.write("</urlset>\n")
```

## A/B'ing the pull concurrency

`SFTP_MAX_CONCURRENT_CONNECTIONS=1` makes `downloadSftpFiles` keep exactly one
transfer in flight, which is precisely what the old sequential loop did — so it
is a clean control against the same binary, isolating concurrency as the only
variable. Restart the backend between runs and let each finish: an abandoned run
keeps downloading server-side after its client disconnects and will silently
share the connection pool with the next one, splitting the throughput and
corrupting both numbers.

## Disconnect / reconnect / abandonment

`cleaner-reconnect.mjs` and `cleaner-abandon.mjs` verify the two halves of the
detached-run behaviour (`sitemaps/cleanerRuns.ts`). Both drive the real endpoints
against a real SFTP source — this behaviour cannot be typechecked, and both scripts
caught genuine bugs that compiled fine.

```sh
# reconnect: kill the client mid-transfer, confirm the run continues and a
# reconnect sees live progress and the download token
node backend/bench/cleaner-reconnect.mjs

# abandonment: kill the client and DO NOT reconnect; confirm the run is stopped
# after the grace period and the SFTP slot is actually released.
# Needs a corpus big enough that the pull outlives the grace window — 500 files
# at ~2.5 files/s is ~200s against a 60s grace. Run the backend with
# CLEANER_ABANDON_GRACE_MINUTES=1 (the configurable floor) so this takes a minute
# rather than five.
node backend/bench/cleaner-abandon.mjs <sftp-domain-folder>
```

Watch `pool.available` from `GET /api/sftp/domains` — that is the number the whole
change is about. A stopped run must return it to `limit`.
