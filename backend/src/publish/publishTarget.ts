import { pool } from "../db/pool.js";
import { assertSafeDomain } from "../sftp/sftpClient.js";
import { normalizeHost } from "../sitemaps/domain.js";

// Where a session publishes to. THE single place that answers "which S3 key
// prefix do this session's sitemaps belong under", so no caller can answer it
// differently.
//
// This exists because of a production incident. The prefix used to be built from
// a `domain` string the CLIENT sent with every publish request, which the
// frontend filled from `new URL(session.base_url).host` — verbatim, unnormalized.
// The SFTP folder the files were actually pulled from was a separate value that
// lived only in BullMQ job data. So a session pulled from the folder
// "fastenersprocurement.com" whose base_url was typed
// "https://www.fastenersprocurement.com" published every file to
// sites/www.fastenersprocurement.com/sitemaps/ and left
// sites/fastenersprocurement.com/sitemaps/ — where production actually serves
// from — stale, reporting complete success.
//
// Two rules make that structurally impossible rather than merely warned about:
//
//   1. An SFTP-pulled session's prefix comes from sessions.sftp_domain. base_url
//      cannot override it, and the client cannot supply it at all.
//   2. Everything else normalizes base_url's host through the SAME normalizeHost()
//      the domain-mismatch check has always used (lowercase, drop a leading
//      "www."), so www and non-www can never select between two folders.
//
// The PUBLIC url host is deliberately NOT normalized and NOT the same field — see
// PublishTarget.publicHost.

export type SessionPublishSource = {
  sftp_domain: string | null;
  base_url: string | null;
};

export type PublishTarget = {
  // Canonical host that decides the S3 key prefix. Normalized, so one site has
  // exactly one prefix regardless of how its base_url was typed.
  prefixDomain: string;
  // The host the sitemaps are SERVED at, used for the public <loc> urls in the
  // regenerated index. NOT normalized, and intentionally allowed to differ from
  // prefixDomain: if a site genuinely serves at www.example.com, stripping the
  // www from its <loc> values would point search engines at a redirecting host.
  // Where objects are STORED and what host SERVES them are separate questions —
  // the same reason s3.prefixTemplate and publicSitemapUrlTemplate are separate
  // config (see config.ts).
  publicHost: string;
  // Which rule produced prefixDomain. Surfaced in the UI and recorded on the
  // audit row so "why this prefix?" is answerable without re-deriving it.
  source: "sftp" | "base_url";
  // Set when the SFTP folder and base_url's host disagree. The SFTP folder still
  // wins — that is the point — but the disagreement is logged and shown rather
  // than resolved silently.
  baseUrlHostIgnored: string | null;
};

export class PublishTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishTargetError";
  }
}

function hostFromBaseUrl(baseUrl: string | null): string | null {
  if (!baseUrl) {
    return null;
  }

  try {
    const url = new URL(baseUrl);

    // Same protocol gate as hostFromLoc() in sitemaps/domain.ts and
    // parseBaseUrl() at session creation. A non-http(s) base_url should never
    // have reached the database, and if one has, it must not quietly become the
    // host that decides which production folder is overwritten.
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    // .hostname, not .host: a port would become part of an S3 key prefix.
    return url.hostname || null;
  } catch {
    return null;
  }
}

// Pure resolution over a session row. Separated from the query so the rule is
// testable directly — the equality this function guarantees is the whole fix, and
// it should not need a database to demonstrate.
export function publishTargetFromSession(
  session: SessionPublishSource
): PublishTarget {
  const sftpDomain = session.sftp_domain?.trim() || null;
  const baseUrlHost = hostFromBaseUrl(session.base_url);

  // The SFTP folder wins outright when present. Not "wins unless base_url looks
  // more specific" — an unconditional rule is the only kind that cannot drift,
  // and the folder name is the one value that provably matches where this
  // domain's files came from.
  const rawPrefixHost = sftpDomain ?? baseUrlHost;

  if (!rawPrefixHost) {
    throw new PublishTargetError(
      "Cannot work out where to publish: this session has no SFTP source domain and no usable base URL host."
    );
  }

  const prefixDomain = normalizeHost(rawPrefixHost);

  // Defence in depth. This value now comes from our own database rather than a
  // request body, but it is still interpolated into an S3 key prefix, and a
  // stored value containing a slash or ".." would write outside the prefix.
  try {
    assertSafeDomain(prefixDomain);
  } catch {
    throw new PublishTargetError(
      `Cannot publish: "${rawPrefixHost}" is not usable as a storage prefix.`
    );
  }

  return {
    prefixDomain,
    // Falls back to the prefix host only when there is no base_url to read a
    // serving host from.
    publicHost: baseUrlHost ?? prefixDomain,
    source: sftpDomain ? "sftp" : "base_url",
    baseUrlHostIgnored:
      sftpDomain && baseUrlHost && normalizeHost(baseUrlHost) !== prefixDomain
        ? baseUrlHost
        : null
  };
}

// Resolve a session's publish target from the database. Every publish path —
// preview, the enqueue route, and the worker job — calls THIS rather than
// accepting a domain from its caller, so there is no path by which a stale page,
// a hand-made request, or an outdated queued job can choose a different prefix.
export async function resolvePublishTarget(
  sessionId: string
): Promise<PublishTarget> {
  const result = await pool.query<SessionPublishSource>(
    "SELECT sftp_domain, base_url FROM sessions WHERE id = $1::uuid",
    [sessionId]
  );

  if (result.rowCount === 0) {
    throw new PublishTargetError("session not found");
  }

  return publishTargetFromSession(result.rows[0]);
}
