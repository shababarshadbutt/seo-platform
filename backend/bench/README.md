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
