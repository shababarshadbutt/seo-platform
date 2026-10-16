-- A single row's write failing used to abort the ENTIRE categorize /
-- status-check / status-sample batch (up to categorizerCrawl.batchSize rows,
-- or in status-sample's case, every remaining category), because those jobs
-- wrote each batch as one multi-row `UPDATE ... FROM (VALUES ...)` statement
-- with no per-row isolation — see categorizerCategorizeJob.ts,
-- categorizerStatusCheckJob.ts, categorizerStatusSampleJob.ts. One bad
-- `::bigint`-bound id (or any other per-row cast failure) threw the whole
-- statement out, which propagated up and FAILED the whole phase, surfacing a
-- raw Postgres error in the UI with no way to skip past it.
--
-- 'failed' is the new terminal state for a row whose write genuinely cannot
-- be isolated-retried successfully: the job now bisects a failing batch down
-- to the one offending row (sitemaps/batchWriteFaultIsolation.ts), marks that
-- row 'failed' with its error captured, and keeps going instead of throwing.
-- categorizerGenerateJob.ts already only reads category_state = 'categorized'
-- (same mechanism migration 065 used for 'excluded'), so a 'failed' row is
-- automatically dropped from output with no change needed there.
-- NOT VALID, and never explicitly validated: a plain `ADD CONSTRAINT ... CHECK`
-- forces Postgres to scan EVERY existing row (across all 16 partitions) to
-- prove it holds, under an ACCESS EXCLUSIVE lock for the whole scan — on this
-- table (tens of millions of rows at real scale) that is a multi-minute,
-- deploy-blocking stall, not a formality. Live-caught: the first attempt to
-- ship this migration hung an AWS deploy for 15+ minutes before anyone
-- realized the "stuck" backend/worker containers were actually both waiting
-- on this ALTER, not crashed.
--
-- Skipping validation is CORRECT here, not just faster: the old constraints
-- only allowed a SUBSET of these values ('pending', 'categorized', 'excluded'
-- / 'pending', 'checking', 'checked', 'skipped'). Every row already
-- satisfies the OLD, stricter constraint, so it trivially satisfies this
-- strictly-wider one too — there is no existing row a scan could ever find
-- violating it. NOT VALID only affects retroactive verification of rows
-- already in the table; it still fully enforces the check on every new
-- INSERT/UPDATE from the moment this commits.
ALTER TABLE categorizer_urls
  DROP CONSTRAINT categorizer_urls_category_state_known;
ALTER TABLE categorizer_urls
  ADD CONSTRAINT categorizer_urls_category_state_known
  CHECK (category_state IN ('pending', 'categorized', 'excluded', 'failed'))
  NOT VALID;

ALTER TABLE categorizer_urls
  DROP CONSTRAINT categorizer_urls_check_state_known;
ALTER TABLE categorizer_urls
  ADD CONSTRAINT categorizer_urls_check_state_known
  CHECK (check_state IN ('pending', 'checking', 'checked', 'skipped', 'failed'))
  NOT VALID;

-- One shared free-text column for whichever phase's isolated write failed on
-- this row (categorize or status-check) — same convention as
-- categorizer_sessions.error / categorizer_jobs.error. Only one phase at a
-- time is realistically ever writing a given row, so one column (last writer
-- wins on the rare case both somehow fail) is simpler than a column per phase.
ALTER TABLE categorizer_urls
  ADD COLUMN IF NOT EXISTS error text;

-- How many rows a COMPLETE phase had to isolate-and-skip, so the UI can show
-- "done, but N need attention" without overloading items_done/items_total
-- (which track rows processed, not rows that failed).
ALTER TABLE categorizer_jobs
  ADD COLUMN IF NOT EXISTS failed_count integer NOT NULL DEFAULT 0;
