-- Full-population URL verification (verify-then-act).
--
-- WHY. Sampling checks only 5-20 URLs per pattern (sampled_urls), so "Delete
-- URLs" could only ever delete the sampled preview rows — the other thousands of
-- URLs in the same pattern were never HTTP-verified and never deletable. This
-- table stores ONE row per (session, url) for EVERY URL enumerated from the
-- actual sitemap XML on disk (not the capped pattern_urls pool), each carrying
-- its own confirmed HTTP status, so deletion can act on the full verified set
-- instead of the sample.
--
-- Deletion marks mirror sampled_urls (023): is_deleted_from_sitemap +
-- deleted_from_files, and the file rebuild in urlDeletion.ts takes the UNION of
-- both tables' marks. Rows marked deleted survive re-verification (they are no
-- longer in the files, but restore needs them) — see verifyUrlsJob.ts.
--
-- Job tracking deliberately reuses maintenance_jobs with kind 'verify-urls'
-- rather than adding a verification_jobs table: the polling shape (status /
-- total / done / items_changed / error) is identical. For that kind ONLY,
-- files_total / files_done carry URL counts, not file counts ("Verifying 187 of
-- 269 URLs…") — documented here and at the writer in verifyUrlsJob.ts.
CREATE TABLE IF NOT EXISTS verified_urls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  -- Which selected pattern template the URL's pathname matched (first match
  -- wins). Nullable + cascading so deleting a pattern doesn't strand rows.
  pattern_id uuid REFERENCES patterns(id) ON DELETE CASCADE,
  -- The <loc> exactly as it appears in the sitemap XML — the string the deletion
  -- engine matches byte-for-byte, NOT the (possibly re-hosted) probed target.
  url text NOT NULL,
  http_status integer,
  http_status_category text,
  final_url text,
  error_reason text,
  -- Display filenames whose <loc>s contained this URL (a URL can appear in
  -- several files); seeds candidate-file scans and the delete job's file scope.
  source_files text[] NOT NULL DEFAULT '{}',
  checked_at timestamptz,
  is_deleted_from_sitemap boolean NOT NULL DEFAULT false,
  deleted_from_files text[],
  -- One row per URL per session: re-verification upserts in place.
  UNIQUE (session_id, url)
);

CREATE INDEX IF NOT EXISTS idx_verified_urls_session_id
  ON verified_urls (session_id);

CREATE INDEX IF NOT EXISTS idx_verified_urls_pattern_id
  ON verified_urls (pattern_id);

-- The Fix-modal listing and counts_by_status both filter by status per session.
CREATE INDEX IF NOT EXISTS idx_verified_urls_session_status
  ON verified_urls (session_id, http_status);

-- Partial: only deleted rows are ever looked up by this flag (rebuild + restore),
-- and they are a small minority of a full-population table.
CREATE INDEX IF NOT EXISTS idx_verified_urls_is_deleted_from_sitemap
  ON verified_urls (is_deleted_from_sitemap)
  WHERE is_deleted_from_sitemap;
