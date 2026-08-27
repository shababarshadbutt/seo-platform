-- A FINISHED CLEANER RUN, DURABLY (v1.86).
--
-- WHAT WAS WRONG. The Sitemap Cleaner is stateless by design, and routes/cleaner.ts
-- says so at length: nothing was written to the database, and the only handle on a
-- finished run was a random download token held in an in-process Map with a
-- setTimeout behind it. Three consequences followed, and an operator hit all three:
--
--   * AN API RESTART INVALIDATED EVERY TOKEN AT ONCE. The Map is process-local, so
--     a deploy or a crash orphaned every cleaned run — the bytes were still on the
--     uploads volume and nothing knew their names.
--   * NOTHING COULD LIST THEM. There was a GET for one run id and no collection
--     route, so a token you no longer had was a run you could not reach.
--   * THE MIGRATION PAGE THROWS THE TOKEN AWAY ON PURPOSE. It calls
--     history.replaceState to strip it from the URL as soon as the handoff loads,
--     which is right — a token in the address bar gets pasted and shared — but with
--     nothing persisting it, a reload of that tab left an empty form and a cleaned
--     sitemap that could only be reproduced by cleaning it again. On an 11.5M-URL
--     site that is a long job to repeat for a dropped connection.
--
-- WHAT THIS IS AND IS NOT. This is an INDEX of runs whose bytes are still on disk,
-- not a store of cleaned sitemaps and not a work queue. The files remain the source
-- of truth; a row here is only a way to name them again. So:
--
--   * out_dir is recorded rather than derived, for the same reason migration 031
--     records original_filename rather than inferring it — the layout that produced
--     a path is free to change, and a stored path keeps working.
--   * expires_at is written by the API from the same TTL that schedules the working
--     directory's removal, so the row and the bytes are given one shared deadline
--     instead of two that can disagree.
--   * A ROW MAY OUTLIVE ITS FILES and that is expected, not a bug to design out.
--     staleArtifactSweep is filesystem-driven on purpose (it consults no Map, no job
--     row and no table) and may remove a directory this table still names. Readers
--     therefore confirm the directory exists before offering a run, and the sweep
--     deletes the row when it removes the tree. Treating the disk as the authority
--     is what keeps a restart from resurrecting a run that is no longer there.
--
-- NO FOREIGN KEY, deliberately. A cleaner run has no session — it PRECEDES one, and
-- the handoff is what creates the session from it. There is nothing to reference.
CREATE TABLE IF NOT EXISTS cleaner_runs (
  run_id uuid PRIMARY KEY,
  -- The handle the browser holds. UNIQUE because it is what every existing route
  -- looks a run up by; it is a capability, so it is random and never derived.
  download_token uuid NOT NULL UNIQUE,
  domain text NOT NULL,
  subfolder text,
  zip_filename text NOT NULL,
  out_dir text NOT NULL,
  -- Counts as they were REPORTED by the clean, so the picker can say "491 files ·
  -- 11.5M URLs" without re-reading and re-parsing every output file to answer a
  -- dropdown. They exist nowhere else: today they live only in the terminal SSE
  -- frame, which is gone the moment the page that received it reloads.
  file_count integer NOT NULL,
  url_count bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

-- The picker's only query: live runs, newest first.
CREATE INDEX IF NOT EXISTS cleaner_runs_expires_at_idx
  ON cleaner_runs (expires_at DESC);

COMMENT ON TABLE cleaner_runs IS
  'Index of finished Sitemap Cleaner runs whose output is still on disk (v1.86), so a handoff token survives an API restart and the Migration page can offer a cleaned sitemap instead of making the operator clean it again. NOT a store of cleaned files: out_dir on the uploads volume is the source of truth, and a row whose directory has been swept is ignored and deleted.';

COMMENT ON COLUMN cleaner_runs.expires_at IS
  'When the API intends to delete this run''s working directory (RUN_TTL_MS after the clean finished). Advisory, not enforced: staleArtifactSweep is age- and filesystem-driven and may remove the tree independently, so readers must confirm out_dir still exists.';
