ALTER TABLE patterns
  ADD COLUMN IF NOT EXISTS source_file TEXT;

ALTER TABLE sampled_urls
  ADD COLUMN IF NOT EXISTS source_file TEXT;
