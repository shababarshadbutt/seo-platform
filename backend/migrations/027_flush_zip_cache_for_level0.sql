-- v1.34: download ZIPs are now built with compression level 0 (STORE) for speed.
-- Any pre-generated ZIP created before this deploy is still a valid level-9
-- archive, but to guarantee every session regenerates at level 0, drop the
-- cached paths + progress here so the next download (or completion) rebuilds
-- them. The orphaned level-9 .zip files on disk are pruned by the daily
-- cleanup-zips job. Runs once per environment (schema_migrations gate).
UPDATE sessions
SET zip_all_path = NULL,
    zip_edited_path = NULL,
    zip_generated_at = NULL,
    zip_progress = 0,
    zip_progress_file = 0
WHERE zip_all_path IS NOT NULL
   OR zip_edited_path IS NOT NULL
   OR zip_generated_at IS NOT NULL
   OR zip_progress <> 0
   OR zip_progress_file <> 0;
