-- Per-file progress for the verify-urls ENUMERATION phase (v1.53).
--
-- WHY (the reported bug). "Check and delete by status code" on a pattern with
-- 10,847,771 matching URLs sat on "Finding this pattern's URLs in the sitemap
-- files…" with no progress for 10+ minutes. That is not a rendering fault: the
-- panel shows that text whenever urls_total === 0, and verifyUrlsJob sets
-- files_total = 0, files_done = 0 immediately BEFORE calling
-- enumeratePopulation() and only writes real numbers AFTER it returns. For the
-- whole enumeration — "tens of seconds on a 1.3M-URL session" by that file's own
-- comment, and far longer above it — the row is frozen at 0/0, so an
-- indeterminate spinner is the only honest thing the UI could draw. There was no
-- progress signal to render: enumeratePopulation had no callback at all.
--
-- WHY NEW COLUMNS INSTEAD OF REUSING files_total/files_done. Those two are
-- ALREADY overloaded for this kind: verifyUrlsJob's header comment and migration
-- 038 both document that for kind 'verify-urls' they carry URL counts, not file
-- counts ("Verifying 187 of 269 URLs…"). Enumeration progress is a FILE count
-- over a different denominator, and it runs in a phase where the URL total is by
-- definition not yet known. Putting a third meaning on the same two columns is
-- how the original confusion gets rebuilt one release later — the reader would
-- have to know which phase a row is in before knowing what its numbers mean.
--
-- Nullable with no default, and that is load-bearing rather than incidental: it
-- is what lets the client tell the two phases apart without a separate flag.
--
--   enum_files_total IS NULL          -> not enumerating (either not started, or
--                                       finished and cleared)
--   enum_files_total IS NOT NULL      -> enumerating; render files done/total
--   files_total > 0                   -> enumeration finished, URL phase live
--
-- verifyUrlsJob clears both back to NULL when enumeration completes, so the
-- transition to the URL-checking phase is unambiguous in one poll rather than
-- inferred from two counters moving.
--
-- Existing rows read as "not enumerating", which is correct for every finished
-- job and matches the pre-v1.53 behaviour exactly.
ALTER TABLE maintenance_jobs
  ADD COLUMN IF NOT EXISTS enum_files_total integer,
  ADD COLUMN IF NOT EXISTS enum_files_done integer;

COMMENT ON COLUMN maintenance_jobs.enum_files_total IS
  'For kind ''verify-urls'': sitemap files to scan in the enumeration phase. NULL = not enumerating. Distinct from files_total, which carries URL counts for this kind.';

COMMENT ON COLUMN maintenance_jobs.enum_files_done IS
  'For kind ''verify-urls'': sitemap files scanned so far in the enumeration phase. NULL = not enumerating.';
