-- v1.39 Fix 2 — record WHY a sampled URL got no HTTP status so the results
-- drawer can show an actionable message instead of a bare "No response".
--
-- Values written by the sampler (samplePatternsJob.ts):
--   'ssl_cert'    — TLS/certificate failure (corporate SSL-inspection proxy)
--   'timeout'     — the request timed out / was aborted
--   'no_response' — connection refused / DNS / other network failure
-- NULL for any row that received an HTTP status (the common case).
ALTER TABLE sampled_urls
  ADD COLUMN IF NOT EXISTS error_reason text;
