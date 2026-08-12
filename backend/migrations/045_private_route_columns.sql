-- WHICH NETWORK PATH measured this URL (v1.63).
--
-- WHY PERSIST IT. Health checks can now reach a host two ways: over the public
-- internet through the site's edge (and its AWS WAF), or straight to the host's
-- private VPC address, where no WAF, no CDN and no rate rule is in the path. Those
-- are different infrastructure answering the same question, and a verdict is only
-- comparable to another verdict measured the same way.
--
-- Concretely, this is what makes the rollout auditable. Every stage of enabling
-- private routing is "did the numbers move because the site changed, or because we
-- changed how we asked?" — and the only way to answer it is a column that says how
-- each row was measured. Without it, the comparison is a guess about which run
-- happened before which config change.
--
-- NOTE WHAT DOES NOT CHANGE: sampled_urls.url and verified_urls.url keep the PUBLIC
-- https identity of the page, exactly as before. The private address never appears in
-- a stored URL — only DNS resolution is diverted (see http/privateRoute.ts) — so
-- nothing downstream that matches these URLs against sitemap <loc> values is affected.
--
-- NULLABLE with no default, following the used_fallback_profile precedent in 043:
-- existing rows predate private routing and genuinely have no answer, which is
-- different from FALSE ("this went over the public internet"). NULL = unknown/never
-- applicable, FALSE = public path, TRUE = private VPC path.
--
-- BOOLEAN rather than a route TEXT column: verified_urls holds up to ~1.3M rows per
-- session, and the two facts worth storing are already carried by one bit. Which
-- specific IP served a host is a property of the host, recorded once per run in the
-- diagnostics event log (private_route_selected), not per URL.
ALTER TABLE sampled_urls
  ADD COLUMN IF NOT EXISTS via_private_route BOOLEAN;

ALTER TABLE verified_urls
  ADD COLUMN IF NOT EXISTS via_private_route BOOLEAN;

COMMENT ON COLUMN sampled_urls.via_private_route IS
  'TRUE when this verdict came from a request routed to the host private VPC address over http. FALSE when it went over the public internet through the site edge. NULL for rows written before private routing existed. The url column is unaffected either way - it always holds the public identity of the page.';

COMMENT ON COLUMN verified_urls.via_private_route IS
  'TRUE when this verdict came from a request routed to the host private VPC address over http. FALSE when it went over the public internet through the site edge. NULL for rows written before private routing existed.';
