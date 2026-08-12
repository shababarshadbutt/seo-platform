import { pool } from "../db/pool.js";
import { privateRouteStatusFor } from "./privateRoute.js";

// THE FLEET REPORT — the deliverable this whole investigation was missing.
//
// A week of diagnosis produced screenshots full of "Not scored" rows and no way to
// answer the only question that matters at 650+ sites: which hosts can we actually
// see, which request profile each one needs, and which ones are refusing us and
// therefore need an allowlist. Per-URL rows cannot answer it — there are 1.3M of them
// per site and they all say the same thing.
//
// Two shapes, one source (host_probe_profiles):
//   * hostStrategyFleetReport() — every host, refused first. This is what gets handed
//     to devops, and edge_server is the column that makes it actionable: 'awselb/2.0'
//     is a load balancer refusing our egress IP (an allowlist conversation with
//     whoever owns it), 'nginx/1.28.3' is the origin itself (a different
//     conversation). Nothing in the database could tell those apart before.
//   * refusedHostsForSession() — the session-scoped subset, so the results page can
//     say it ONCE instead of leaving the user to infer it from a table of unscored
//     patterns.

export type HostStrategyReportRow = {
  host: string;
  verdict: "OK" | "REFUSED";
  winning_rung: string | null;
  edge_server: string | null;
  last_status: number | null;
  decided_at: string;
  // Which network path this host is reached over NOW — not when the verdict was
  // decided. Computed in Node from the private-host map, which deliberately does not
  // live in the database.
  //
  // WHY THIS COLUMN EXISTS. Every verdict in this table was measured over the PUBLIC
  // path, because that is the only path the negotiation ladder ever uses. Once a host
  // is routed privately, a REFUSED row next to it stops meaning "this site is
  // unreachable" and starts meaning "this site's public edge refuses our egress IP,
  // and we now bypass it". Those are opposite conclusions, and without this field the
  // report states the first one.
  route: "private" | "private-disabled" | "public";
};

export async function hostStrategyFleetReport(): Promise<
  HostStrategyReportRow[]
> {
  const result = await pool.query<Omit<HostStrategyReportRow, "route">>(
    `
      SELECT host, verdict, winning_rung, edge_server, last_status,
             decided_at::text AS decided_at
      FROM host_probe_profiles
      ORDER BY
        -- Refused hosts first: they are the ones needing action.
        CASE verdict WHEN 'REFUSED' THEN 0 ELSE 1 END,
        decided_at DESC
    `
  );

  return result.rows.map((row) => ({
    ...row,
    route: privateRouteStatusFor(row.host)
  }));
}

// The host variants a session's probes can legitimately land on.
//
// resolveSampleTarget sends a probe to the sitemap's OWN url when base_url and the
// <loc> differ only by the "www." label, and rateLimitHostKey does not normalise that
// away (www.example.com and example.com are different origins, correctly). So a
// session's learned strategy can be filed under either spelling, and looking up only
// base_url's host would miss it exactly half the time.
//
// Two cheap keyed lookups rather than scanning 1.3M pattern_urls rows for distinct
// hosts. Foreign-domain URLs are filtered out at extraction (v1.23), so a session's
// probes only ever reach these two.
export function hostVariantsForBaseUrl(baseUrl: string): string[] {
  try {
    const url = new URL(baseUrl);
    const host = url.host.toLowerCase();
    const bare = host.replace(/^www\./, "");
    const variants = new Set([host, bare, `www.${bare}`]);

    return Array.from(variants);
  } catch {
    return [];
  }
}

export async function refusedHostsForSession(
  baseUrl: string
): Promise<HostStrategyReportRow[]> {
  const variants = hostVariantsForBaseUrl(baseUrl);

  if (variants.length === 0) {
    return [];
  }

  const result = await pool.query<Omit<HostStrategyReportRow, "route">>(
    `
      SELECT host, verdict, winning_rung, edge_server, last_status,
             decided_at::text AS decided_at
      FROM host_probe_profiles
      WHERE host = ANY($1::text[])
        AND verdict = 'REFUSED'
      ORDER BY decided_at DESC
    `,
    [variants]
  );

  // A host that is now routed privately is NOT refused any more, whatever this row
  // says: the verdict describes a public edge that no longer sits in the path. Left in
  // the fleet report (where `route` explains it) but filtered out of the session
  // banner, which exists to tell a user why their patterns are unscored — and they are
  // not.
  return result.rows
    .map((row) => ({ ...row, route: privateRouteStatusFor(row.host) }))
    .filter((row) => row.route !== "private");
}
