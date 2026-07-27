-- The true incoming filename of a sitemap file, recorded at ingestion.
--
-- Until now the production filename was RECOVERED from the internal stored name
-- by stripping known prefixes (<session>-, fixed-<hex>-, and the current-/legacy-
-- source role). That heuristic is right for almost every file and wrong for the
-- one that matters: a client file genuinely named "current-x.xml" would publish
-- as "x.xml", silently overwriting the wrong object in a bucket with no
-- versioning and no undo.
--
-- This is the fourth time inferring a real filename from a pattern has collided
-- with real client data (duplicate basenames, the .gz extension, the hardcoded
-- index name, and now the role prefix), so it is recorded rather than inferred
-- from here on.
--
-- Nullable on purpose: rows ingested before this migration have no recorded
-- name, and productionFilename() falls back to the existing heuristic for them,
-- so nothing changes retroactively.
ALTER TABLE sitemap_files
  ADD COLUMN IF NOT EXISTS original_filename text;

COMMENT ON COLUMN sitemap_files.original_filename IS
  'True incoming filename as supplied by the source (upload / fetched URL / SFTP pull). NULL for rows ingested before migration 031, which fall back to deriving it from filename.';
