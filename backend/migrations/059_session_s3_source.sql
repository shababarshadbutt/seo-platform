-- Which remote store a session's sitemaps were pulled from.
--
-- Why: "From S3" joins "From SFTP" as a way to fill a session from a remote
-- folder. Both record that folder in sessions.sftp_domain, because that column
-- already means "the folder that decides the publish prefix" — the rule
-- migration 034 introduced after a session published to
-- sites/www.example.com/sitemaps/ and left the live sites/example.com/sitemaps/
-- stale while reporting success.
--
-- Reusing the column rather than adding a second domain column is deliberate.
-- The fix in 034 was ONE unconditional rule: the remote folder beats base_url,
-- always. A second column would fork that rule into two places that could
-- disagree, which is the exact shape of the original bug. So the folder stays in
-- one column and this new one records only WHICH STORE it came from — a label,
-- never an input to the prefix.
--
-- Nullable: only remotely-sourced sessions have one. Uploaded and URL-fetched
-- sessions leave it NULL and keep resolving through normalizeHost(base_url).
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS remote_source_kind text;

COMMENT ON COLUMN sessions.remote_source_kind IS
  'Which remote store sessions.sftp_domain names: ''sftp'' (AWS Transfer Family) or ''s3'' (the sitemaps bucket). NULL for uploaded / URL-fetched sessions, and for SFTP sessions predating this migration that the backfill below did not reach.';

-- Backfill. Every session that already has a folder got it from the only source
-- that could set one before now, so labelling them explicitly keeps
-- publishTarget's mapping honest instead of relying on NULL meaning "sftp"
-- forever. publishTarget still treats NULL as 'sftp' for exactly that reason —
-- this backfill narrows how often that fallback is what answers.
UPDATE sessions
   SET remote_source_kind = 'sftp'
 WHERE sftp_domain IS NOT NULL
   AND remote_source_kind IS NULL;

-- The column keeps its name (renaming it would touch publishTarget, the session
-- queries, the API payload and the frontend for no behavioural gain), but its
-- meaning is now wider than "SFTP". Say so where the next reader will look.
COMMENT ON COLUMN sessions.sftp_domain IS
  'The remote folder name this session''s sitemaps were pulled from — an SFTP directory or an S3 domain prefix; see remote_source_kind for which. Authoritative source of the S3 publish key prefix when set; NULL for uploaded / URL-fetched sessions, which resolve through normalizeHost(base_url). Named sftp_domain for historical reasons (migration 034), when SFTP was the only remote source.';

-- publish_runs.domain_source is free text and needs no schema change to carry a
-- third value; only its documentation is now incomplete.
COMMENT ON COLUMN publish_runs.domain_source IS
  'Where the prefix host came from: ''sftp'' or ''s3'' (both sessions.sftp_domain, distinguished by sessions.remote_source_kind) or ''base_url'' (normalized base_url host).';
