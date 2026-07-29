// Host normalization, mirroring backend/src/sitemaps/domain.ts.
//
// The backend is the source of truth: normalizeHost() there is what the
// domain-mismatch check has always used, and what publish/publishTarget.ts now
// uses to decide a session's S3 key prefix. This copy exists because the frontend
// and backend are separate packages with no shared module, and it must stay
// behaviourally identical — see lib/host.test.ts, which pins the same cases.
//
// Used to auto-fill Base URL from an SFTP domain selection, and to tell the user
// when a Base URL they have edited by hand would no longer resolve to the same
// publish prefix as the SFTP folder the files came from. That divergence is the
// one that put a whole domain's sitemaps in the wrong bucket folder.

// Lowercase and drop a leading "www." (only the www label, never an arbitrary
// subdomain). Identical to normalizeHost() in backend/src/sitemaps/domain.ts.
export function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

// The hostname of a base URL, or null when it is not a usable http(s) URL.
// hostname, not host: a port is not part of the identity we compare on, and the
// backend resolver drops it too.
export function hostFromBaseUrl(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl.trim());

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    return url.hostname || null;
  } catch {
    return null;
  }
}

// Build the Base URL for a session sourced from an SFTP folder.
//
// https:// is assumed rather than asked for — every client site this tool
// publishes for is served over TLS, and a wrong scheme here is visible and
// editable in the field. The domain's own spelling is PRESERVED (a folder named
// "www.example.com" yields https://www.example.com): the field is the site's real
// public address, used for crawling and for the public <loc> values, so it should
// say what the site actually serves at. Normalization is what guarantees both
// spellings still resolve to one storage prefix — it is not something the user
// needs applied to this field.
export function baseUrlFromSftpDomain(domain: string): string {
  const trimmed = domain.trim();

  if (!trimmed) {
    return "";
  }

  // A folder name that already carries a scheme (defensive — the SFTP listing
  // yields bare directory names) is used as-is rather than double-prefixed.
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `https://${trimmed}`;
}

// Whether an edited Base URL still points at the same site as the SFTP folder,
// in the sense that decides the S3 publish prefix. www/case differences are NOT
// a divergence — they normalize to the same prefix — so flagging them would
// train people to ignore the warning.
export function resolvesToSamePrefix(
  baseUrl: string,
  sftpDomain: string
): boolean {
  const host = hostFromBaseUrl(baseUrl);

  if (!host || !sftpDomain.trim()) {
    // Nothing to contradict: an unusable base URL is caught by its own
    // validation, and with no SFTP domain there is no second opinion.
    return true;
  }

  return normalizeHost(host) === normalizeHost(sftpDomain.trim());
}
