# Sitemap Migration Health Checker Requirements

## MVP Architecture

The application runs fully locally with Docker Compose and has two layers:

- SEO Dashboard: health score, page group cards, summary metrics, action hints, charts, pattern detail table, and exports.
- Technical Engine: streaming sitemap parsing, pattern extraction, sampling, HTTP checks, persistence, and BullMQ jobs.

One site is analyzed per session. There is no auth for MVP.

## Required Stack

- Frontend: Next.js 14, React, TypeScript
- UI: Tailwind CSS, shadcn/ui
- Tables: TanStack Table
- Charts: Recharts
- Backend: Fastify, Node.js, TypeScript
- Job Queue: BullMQ
- Queue Store: Redis
- Database: PostgreSQL
- File Storage: local disk at `/uploads`
- XML Parsing: `sax` and `zlib`, streaming only
- HTTP Checks: `undici`, HEAD only
- CSV Export: `json2csv`
- Excel Export: `exceljs`
- PDF Export: Playwright
- Auth: none for MVP
- AI: none for MVP
- Deployment: Docker and Docker Compose

## User Flow

1. New Session / Upload
2. Processing / Live Progress
3. SEO Dashboard
4. Pattern Detail Table
5. Export

## Pattern Extraction

- Parse all `<loc>` tags with a streaming `sax` parser.
- Never use `DOMParser` or full-file `readFileSync` parsing for XML.
- Strip domain and retain only the path.
- Split paths by `/`.
- Analyze segment positions across all URLs in the file.
- Classify segments using the configured thresholds.
- Group URLs by resolved pattern string.
- Compute total URL count and coverage percentage per pattern.

Threshold note: initial requested classification was:

- Unique values at a position greater than `100` => `{param}`
- Unique values at a position less than or equal to `100` => static label using the most common value

Confirm before changing these thresholds.

## Sampling And Verification

- Randomly select `N` URLs per pattern using the user-selected sample size.
- Dispatch HEAD checks from the Fastify worker only.
- Never run HEAD checks from Next.js API routes or the browser.
- Enforce user-configured concurrency, default `10`, maximum `30`.
- Timeout per request: `5` seconds.
- Follow redirects once.
- Do not follow redirects beyond the first hop.

HTTP scoring:

- `2xx` => full hit, score weight `1.0`
- `301` / `302` => partial hit, score weight `0.5`
- `404`, `5xx`, timeout => miss, score weight `0`

Status:

- `>= 80%` => GOOD
- `50-79%` => WARNING
- `< 50%` => BAD

Overall Health Score is the weighted average confidence across all patterns, weighted by coverage percentage.

## HTTP Status Granularity

Track counts separately per pattern:

- `2xx`
- `301/302`
- `404`
- `5xx`
- timeout

Each sampled URL should store:

- original URL
- final destination URL, when redirected
- redirect count
- HTTP status
- HTTP status category
- response time
- hit/miss status

## Redirect Analysis

- Store original URL and final destination URL for each sampled redirect.
- Detect whether a path segment is stripped during redirect, such as `/industrial-automation/` disappearing.
- Surface pattern-level insight when redirects suggest a migration artifact segment.

Example insight:

`Redirects suggest segment industrial-automation is a migration artifact.`

## Sitemap Index Support

- Detect sitemap index files.
- Auto-parse and queue all child sitemap URLs.
- Show file tree in the UI: index file -> child files -> status per file.
- Process each child file as a separate BullMQ job.

## Malformed Sitemap Handling

- If `sax` parsing fails mid-file, mark the sitemap file as invalid.
- Store parse error text and error offset.
- Store partial URL results extracted before failure.
- Continue processing remaining files.
- Do not abort the entire session because one file is malformed.

## Segment Anomaly Detection

After pattern extraction:

- Scan static segments across all patterns.
- Flag static segments appearing in `100%` of a pattern's URLs when they look like injected path artifacts.
- Surface a Suspicious Segment warning on the dashboard.

Heuristic note: the exact definition of "non-noun" or "path-like injected segment" needs confirmation before implementation.

## Missing Content Detection

When both old and new sitemaps are uploaded:

- Diff the old and new pattern sets.
- Flag old sitemap pattern types that have zero equivalent in the new sitemap.

Example insight:

`Product page pattern found in old sitemap — no matching pattern in new sitemap.`

## Dashboard Additions

Add cards for:

- Redirect Patterns count
- Suspicious Segment Alerts count
- Invalid/Malformed Sitemap Files count

## Database Model

Base tables:

- `sessions`: id, name, base_url, sample_size, concurrency, status, created_at
- `sitemap_files`: id, session_id, filename, total_urls, parsed_at
- `patterns`: id, session_id, template, total_urls, coverage_pct, confidence_pct, status
- `sampled_urls`: id, pattern_id, url, http_status, response_ms, is_hit, checked_at
- `exports`: id, session_id, type, file_path, created_at

Additional required columns:

- `sampled_urls.final_url`
- `sampled_urls.redirect_count`
- `sampled_urls.http_status_category`
- `sitemap_files.is_valid`
- `sitemap_files.parse_error`
- `sitemap_files.parse_error_offset`
- `sitemap_files.is_index`
- `patterns.has_suspicious_segment`
- `patterns.suspicious_segment_value`
- `patterns.redirect_pct`

## Scaffold Sequence

Implementation must proceed in this order, with each step confirmed working before continuing:

1. Docker Compose + all service skeletons running and healthy
2. PostgreSQL schema + migrations
3. Fastify backend: file upload endpoint + `sax` streaming parser
4. BullMQ job wiring: pattern extraction job + sampling job
5. Next.js frontend shell: Upload screen + Processing screen with live BullMQ progress via SSE or WebSocket
6. Pattern extraction logic
7. HEAD check sampling logic
8. SEO Dashboard screen
9. Pattern Detail Table screen
10. Export: CSV, then XLSX, then PDF

