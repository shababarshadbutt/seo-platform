-- Pattern rename / structure-transform / transform-undo as BACKGROUND jobs.
--
-- WHY. All three ran synchronously inside one HTTP request while rewriting every
-- sitemap file the pattern spans. Measured on an 823-file / 6.58M-URL session:
-- the transform takes 136s, and the client's 180s EXPORT_API_TIMEOUT_MS is the
-- only thing that gives up — the server commits regardless (proven: a client
-- aborted at 30s, the transform still COMMITted ~130s later). So the request
-- timeout never cancelled anything; it just hid a completed mutation from the
-- user, who then retried and re-applied it. Bigger sessions (or the VM's slower
-- disk) push past 180s every time.
--
-- Same shape of fix as bulk replace (020) and the Cleaner's SFTP pull: the route
-- validates, enqueues, and returns a job id; the worker does the rewrite and
-- publishes progress here for the frontend to poll.
CREATE TABLE IF NOT EXISTS pattern_structure_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  pattern_id uuid NOT NULL REFERENCES patterns(id) ON DELETE CASCADE,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  -- Stable hash of the operation's inputs. This is what makes a retry after a
  -- client timeout recognisable as the SAME request rather than a new one, so it
  -- can be attached to the in-flight job (or answered with the finished job's
  -- result) instead of re-applying the rewrite or tripping
  -- patterns_unique_template_per_session_role with a misleading "already exists".
  request_fingerprint text NOT NULL,
  -- The full validated request, so the worker re-derives everything server-side.
  params jsonb NOT NULL,
  files_total integer NOT NULL DEFAULT 0,
  files_done integer NOT NULL DEFAULT 0,
  urls_rewritten bigint NOT NULL DEFAULT 0,
  -- The response body the synchronous route used to return, replayed verbatim to
  -- a poller (and to a retry that arrives after completion).
  result jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT pattern_structure_jobs_kind_known
    CHECK (kind IN ('RENAME', 'TRANSFORM', 'TRANSFORM_UNDO')),
  CONSTRAINT pattern_structure_jobs_counts_nonnegative
    CHECK (files_total >= 0 AND files_done >= 0 AND urls_rewritten >= 0)
);

-- AT MOST ONE in-flight job per pattern, enforced by the DATABASE rather than a
-- check-then-act in the route. Two overlapping transforms on one pattern would
-- both rewrite the same files and interleave their filename repointing, leaving
-- the undo chain pointing at copies the other run had already replaced. A
-- concurrent enqueue now fails on this index and the route attaches the caller to
-- the running job instead.
CREATE UNIQUE INDEX IF NOT EXISTS pattern_structure_jobs_one_active_per_pattern
  ON pattern_structure_jobs (pattern_id)
  WHERE status IN ('PENDING', 'RUNNING');

-- "Latest job for this pattern" is the status endpoint's only query shape.
CREATE INDEX IF NOT EXISTS idx_pattern_structure_jobs_pattern_started
  ON pattern_structure_jobs (pattern_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_pattern_structure_jobs_session_id
  ON pattern_structure_jobs (session_id);

-- Retry-after-timeout lookup: most recent COMPLETE job matching a fingerprint.
CREATE INDEX IF NOT EXISTS idx_pattern_structure_jobs_fingerprint
  ON pattern_structure_jobs (pattern_id, request_fingerprint, started_at DESC);
