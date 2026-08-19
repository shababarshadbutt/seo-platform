-- PARTIAL publish outcomes on the audit trail from migration 033.
--
-- Why: a publish of 2,650 sitemaps wrote every object AND the regenerated index
-- successfully, then had its CloudFront invalidation rejected. Because the
-- invalidation call was uncaught, the whole run was stamped FAILED with
-- uploaded_count left at its 0 default — so the only durable record of a
-- SUCCESSFUL production update said nothing had been written, and the obvious
-- remedy (re-upload 8 GB) was the wrong one. The status vocabulary had no way to
-- say "the bytes are live, one downstream step is not done".
--
-- status now reads: STARTED | COMPLETE | PARTIAL | FAILED, where
--   PARTIAL = objects were written to production, but some files were skipped
--             after retries and/or the CDN invalidation did not fully succeed.
--   FAILED  = the run aborted; production may be mixed but was not completed.
-- Left as free text rather than an enum, matching the original column.

ALTER TABLE publish_runs
  ADD COLUMN IF NOT EXISTS failed_file_count integer NOT NULL DEFAULT 0;

ALTER TABLE publish_runs
  ADD COLUMN IF NOT EXISTS failed_files jsonb;

ALTER TABLE publish_runs
  ADD COLUMN IF NOT EXISTS invalidation_strategy text;

ALTER TABLE publish_runs
  ADD COLUMN IF NOT EXISTS invalidation_error text;

COMMENT ON COLUMN publish_runs.failed_file_count IS
  'Files that could not be uploaded even after retries. Non-zero means status is PARTIAL: the rest of the files DID go live, and only these need re-publishing.';

COMMENT ON COLUMN publish_runs.failed_files IS
  'Per-file detail for the failures: [{filename, reason, still_indexed}]. still_indexed records whether the regenerated index still references the file because an older version of the object is live in the bucket — kept deliberately, since dropping it would de-index live URLs over a transient upload error.';

COMMENT ON COLUMN publish_runs.invalidation_strategy IS
  'How the CDN was invalidated: ''exact'' (one path per changed file, batched), ''wildcard'' (one scoped path for the domain''s sitemap folder, used above CLOUDFRONT_WILDCARD_THRESHOLD because CloudFront caps a request at 3,000 paths and bills per path), or ''skipped'' (no distribution configured).';

COMMENT ON COLUMN publish_runs.invalidation_error IS
  'Why the CDN invalidation did not fully succeed. NEVER means the publish failed: this is stamped only after every object has already been written, so it means the edge may serve stale sitemaps until their TTL lapses.';
