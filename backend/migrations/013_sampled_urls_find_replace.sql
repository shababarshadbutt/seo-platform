-- Find & Replace support for sampled URLs.
-- original_url holds the value a sampled URL had before the first find/replace was
-- applied, so a replace can be fully undone. NULL means the URL has never been
-- rewritten (its current url IS the original).
ALTER TABLE sampled_urls
ADD COLUMN IF NOT EXISTS original_url text;
