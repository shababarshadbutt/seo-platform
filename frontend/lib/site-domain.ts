// Turning an SFTP folder name into the Website-domain field's value.
//
// The Cleaner's SFTP source lists one directory per client under the base path
// (backend/src/sftp/sftpClient.ts), so the option values are bare hostnames like
// "limitlessaerospace.com". The Domain field next to it wants a full origin —
// "https://www.limitlessaerospace.com" — because that is what the cleaned <loc>
// values are written against.
//
// Until now those two were unrelated: picking a domain from the dropdown left the
// Domain field empty and the panel carried a note admitting as much, so every run
// meant retyping a hostname that was already on screen one control away. Typing it
// slightly differently is not a cosmetic mistake either — the domain decides which
// URLs are KEPT, so a typo silently drops the whole corpus as wrong-domain.

// Whether to prepend "www.", given a hostname that does not already have it.
//
// Two labels ("example.com") is a registrable domain and gets "www.". Three or
// more ("shop.example.com") is already a subdomain and is left alone — prepending
// there would produce "www.shop.example.com", a host that generally does not
// exist.
//
// KNOWN LIMITATION, and a deliberate one: a multi-part public suffix
// ("example.co.uk") also has three labels, so it is left without "www." rather
// than being www'd. Telling those two apart needs a public-suffix list, which is
// a large dependency for one text field. The failure mode is chosen to be the
// harmless one — an origin that is right but missing "www.", which the user can
// see and edit, rather than a fabricated host that looks authoritative.
function shouldPrependWww(host: string): boolean {
  return !host.startsWith("www.") && host.split(".").length === 2;
}

// Best-effort origin for a domain picked from the SFTP dropdown.
//
// Returns "" for empty input so the caller can clear the field rather than write
// a half-formed value into it. Tolerates an option that already carries a scheme,
// a "www." prefix, a trailing slash or a path, because the folder names come from
// a remote server and nothing here controls how they are written.
export function siteDomainFromSftpDomain(sftpDomain: string): string {
  const trimmed = sftpDomain.trim();

  if (trimmed.length === 0) {
    return "";
  }

  // Drop any scheme, then anything from the first slash on: this field is an
  // ORIGIN, and a trailing slash is specifically called out as wrong by the
  // field's own label ("no trailing slash").
  const host = trimmed
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .split("/")[0]
    .trim()
    .toLowerCase();

  if (host.length === 0) {
    return "";
  }

  return `https://${shouldPrependWww(host) ? "www." : ""}${host}`;
}
