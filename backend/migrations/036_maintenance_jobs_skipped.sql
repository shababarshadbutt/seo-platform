-- Trailing-slash fix: report patterns skipped because the slashed (or unslashed)
-- form of their template is already taken by another pattern in the same
-- session + source_role.
--
-- WHY A COLUMN AT ALL. patterns_unique_template_per_session_role means adding a
-- slash to "/x" fails when a separate "/x/" pattern already exists. The batch
-- UPDATE used to raise the unique violation and abort the WHOLE apply, so one
-- collision among thousands of patterns lost the entire operation. Colliding
-- patterns are now skipped and the rest applied — each pattern's update is
-- independent, so partial success is safe — but a skip that goes unreported is a
-- silent behaviour change, and maintenance_jobs had nowhere to record it (only
-- `error`, which would wrongly mark a successful run as failed).
--
-- Shape mirrors the Cleaner's dropped_files convention: a list of
-- {template, conflicting_template, source_role} objects.
ALTER TABLE maintenance_jobs
  ADD COLUMN IF NOT EXISTS skipped jsonb;

COMMENT ON COLUMN maintenance_jobs.skipped IS
  'Items the job deliberately skipped (not failures). Trailing-slash: patterns whose target template was already taken.';
