-- Snapshot of the pre-apply category / hit state so "Undo last replace" can
-- fully restore rows changed by apply-redirects (which sets category='success',
-- is_hit=true). NULL means the row's current category/is_hit IS the original.
-- Note: named 016 because 015 is already used (015_pattern_renames.sql).
ALTER TABLE sampled_urls
  ADD COLUMN IF NOT EXISTS original_http_status_category http_status_category;

ALTER TABLE sampled_urls
  ADD COLUMN IF NOT EXISTS original_is_hit boolean;
