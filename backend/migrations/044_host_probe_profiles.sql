-- Per-HOST request strategy, learned once and remembered (engine phase 1).
--
-- WHY A HOST TABLE AT ALL. v1.60 escalates per URL: any non-clean result gets a
-- second attempt with the browser profile. That is right for a host that
-- occasionally refuses, and ruinous for one that refuses everything — a fully
-- blocked 1.3M-URL population pays ~2.6M requests to learn the same fact 1.3M
-- times, which at the shipped 5 req/s per-host budget is days of wall clock for no
-- information. The unit that decides how a request must look is the HOST, so that
-- is the unit worth remembering.
--
-- Rows are written by the strategy engine after negotiating a host (at most one
-- probe URL per rung, R0 -> R1 -> R2). Redis holds the hot copy; this table is the
-- durable one AND the fleet report — "which of the 650+ sites can we see, at which
-- rung, and which ones need an allowlist" is a single query over it, which is the
-- deliverable a week of per-URL "Not scored" rows could not produce.
--
-- HOST, not domain, and not session: it is keyed the same way the per-host rate
-- limiter keys its budget (rateLimitHostKey — host:port, lowercased), because the
-- host that receives the traffic is the host whose recipe and budget apply.
-- resolveSampleTarget can send a probe to the www variant of base_url, so keying
-- on the session's domain would learn the wrong thing.
CREATE TABLE IF NOT EXISTS host_probe_profiles (
  host TEXT PRIMARY KEY,
  -- OK: some rung produced a real measurement. REFUSED: the edge answered and
  -- refused every rung. There is deliberately no third value for "we could not
  -- reach it" — an unreachable host is a normal failure the per-URL checker should
  -- report honestly, not a refusal to skip, so the engine simply does not persist
  -- that case.
  verdict TEXT NOT NULL CHECK (verdict IN ('OK', 'REFUSED')),
  -- Which rung answered: 'R0' honest crawler UA, 'R1' browser profile,
  -- 'R2' browser profile over HTTP/2. NULL when verdict = 'REFUSED'.
  winning_rung TEXT CHECK (winning_rung IN ('R0', 'R1', 'R2')),
  -- The `Server:` header of the response that decided this, verbatim.
  --
  -- The single most useful diagnostic this project was missing. 'awselb/2.0'
  -- refusing us is an allowlist conversation with whoever owns that load
  -- balancer; 'nginx/1.28.3' refusing us is the origin itself and a different
  -- conversation entirely. Until now nothing in the database could tell them
  -- apart, and every diagnosis had to start from curl on the box.
  edge_server TEXT,
  -- The HTTP status the deciding response carried (405, 403, 200...). NULL when no
  -- rung ever got a status.
  last_status INTEGER,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT host_probe_profiles_rung_matches_verdict CHECK (
    (verdict = 'OK' AND winning_rung IS NOT NULL) OR
    (verdict = 'REFUSED' AND winning_rung IS NULL)
  )
);

-- The fleet report's sort: refused hosts first, then most recently decided.
CREATE INDEX IF NOT EXISTS host_probe_profiles_verdict_idx
  ON host_probe_profiles (verdict, decided_at DESC);

COMMENT ON TABLE host_probe_profiles IS
  'Learned per-host request strategy: which request profile (rung) a host answers, or REFUSED when it answers none. Redis holds the hot copy; this is the durable record and the source of the fleet report.';
