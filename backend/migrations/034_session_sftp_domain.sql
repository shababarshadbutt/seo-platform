-- The SFTP folder a session's files were pulled from, and the provenance of the
-- publish prefix.
--
-- Why: the S3 publish prefix used to be derived from the session's base_url host
-- VERBATIM, taken from the client on every publish request. The SFTP folder name
-- a session was actually pulled from lived only in BullMQ job data and a log
-- line, so nothing connected the two. A session pulled from the folder
-- "example.com" whose base_url was typed "https://www.example.com" published
-- every file to sites/www.example.com/sitemaps/ and left
-- sites/example.com/sitemaps/ — the prefix production serves from — untouched
-- and stale, while reporting complete success. That happened in production.
--
-- Recording the pull domain makes it the single source of truth for the prefix
-- (see publish/publishTarget.ts): for an SFTP-sourced session the prefix comes
-- from THIS column, never from base_url, so the two can no longer diverge.
-- Non-SFTP sessions fall back to base_url's host run through the same
-- normalizeHost() used for domain-mismatch detection, so www/non-www can no
-- longer select between two different production folders either.
--
-- Nullable: only SFTP-pulled sessions have one, and every session predating this
-- migration resolves through the normalized base_url path.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS sftp_domain text;

COMMENT ON COLUMN sessions.sftp_domain IS
  'The SFTP folder name this session''s sitemaps were pulled from. Authoritative source of the S3 publish key prefix when set; NULL for uploaded / URL-fetched sessions, which resolve through normalizeHost(base_url).';

-- Diagnostics on the audit trail from migration 033. publish_runs.domain records
-- the NORMALIZED host that produced the prefix; these two record what it was
-- resolved from, so a wrong prefix stays diagnosable after the fact without
-- re-deriving anything from current config.
ALTER TABLE publish_runs
  ADD COLUMN IF NOT EXISTS public_host text;

ALTER TABLE publish_runs
  ADD COLUMN IF NOT EXISTS domain_source text;

COMMENT ON COLUMN publish_runs.public_host IS
  'The host used for the public <loc> urls in the regenerated index (base_url''s host, NOT normalized). Deliberately allowed to differ from domain: where objects are stored and what host serves them are different questions.';

COMMENT ON COLUMN publish_runs.domain_source IS
  'Where the prefix host came from: ''sftp'' (sessions.sftp_domain) or ''base_url'' (normalized base_url host).';
