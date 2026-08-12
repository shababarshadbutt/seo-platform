// Which customer hostnames live at which PRIVATE VPC address.
//
// WHY THIS EXISTS. Every URL health check currently leaves the box through its
// public IP and arrives at the site through that site's public edge — which
// costs egress and puts an AWS WAF in the path of a tool whose entire job is
// measuring whether pages answer. The ~650 sites this checker serves are hosted
// on 7 EC2 boxes in the SAME VPC as the checker (10.0.x.x), so the request never
// needs to leave the private network at all. This file is the inventory of that
// fact: hostname -> private IP.
//
// A PARSER, NOT A POLICY. This module answers "is this host mapped, and to
// what?" and nothing else. Whether a mapped host is actually routed privately —
// the feature flag, the scheme, the circuit breaker — is privateRoute.ts's job.
// The split exists so the parser is testable with no filesystem, no config and
// no network, which is the same discipline sampleTarget.ts and hostStrategy.ts
// state for themselves.
//
// HOSTS FILE FORMAT, deliberately. The mapping arrives from devops as /etc/hosts
// content generated from `pm2 list` on each box, complete with `# BEGIN ...`
// banners. Parsing that format verbatim means the file can be pasted from what
// they already maintain, with no reformatting step for a human to get wrong.
import { readFileSync, statSync } from "node:fs";
import { isIP } from "node:net";

import { normalizeHost } from "../sitemaps/domain.js";

export type PrivateHostMatch = {
  ip: string;
  // 4 or 6, taken from the address itself rather than assumed.
  //
  // WHY IT IS CARRIED. The seven private addresses are all IPv4, so this looks like
  // dead weight — until the map is pointed at a real /etc/hosts, which ALWAYS contains
  // `::1 localhost ip6-localhost ip6-loopback`. Answering a v6 address with family 4
  // produces a connect failure that looks like a dead route rather than a bad answer.
  family: 4 | 6;
  // Whether the hostname was listed verbatim, or found via the www-label
  // fallback. Reported in diagnostics because a fleet where everything matches
  // via fallback means the map was generated for the other host form, which is
  // worth knowing before trusting it.
  matchedVia: "exact" | "www-fallback";
};

function ipFamily(ip: string): 4 | 6 {
  return isIP(ip) === 6 ? 6 : 4;
}

export type ParsedHostMap = {
  entries: Map<string, string>;
  // Hostnames listed under two DIFFERENT IPs, keyed by the normalized (www-
  // stripped) host, with every IP claimed for it. These are REMOVED from
  // entries — see the conflict rule below.
  conflicts: Map<string, string[]>;
  warnings: string[];
};

// Lines are parsed, not trusted. Anything unparseable becomes a warning with its
// line number rather than being skipped in silence: a map that quietly holds 640
// of 650 entries looks exactly like a working map, and the 10 missing sites just
// go out over the public internet forever.
export function parseHostsFile(text: string): ParsedHostMap {
  const entries = new Map<string, string>();
  const conflicts = new Map<string, string[]>();
  const warnings: string[] = [];
  // Where each host was first claimed, for a warning message that names both
  // sides of a collision instead of just the second one.
  const firstSeenAt = new Map<string, { ip: string; line: number }>();

  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    // Comments run to end of line, so a trailing `# was 10.0.1.1` is stripped
    // rather than parsed as a hostname.
    const withoutComment = lines[index].split("#")[0];
    const fields = withoutComment.trim().split(/\s+/).filter(Boolean);

    if (fields.length === 0) {
      continue;
    }

    const [ip, ...hostnames] = fields;

    if (!isIP(ip)) {
      warnings.push(
        `line ${lineNumber}: first field "${ip}" is not an IP address — line ignored`
      );
      continue;
    }

    if (hostnames.length === 0) {
      warnings.push(`line ${lineNumber}: ${ip} has no hostname — line ignored`);
      continue;
    }

    for (const raw of hostnames) {
      const host = raw.toLowerCase();

      // Someone pasted a URL instead of a hostname. Accepting it would file the
      // entry under a key no lookup ever produces, i.e. a silent miss.
      if (/[/:@]/.test(host)) {
        warnings.push(
          `line ${lineNumber}: "${raw}" looks like a URL, not a hostname — entry ignored`
        );
        continue;
      }

      const family = normalizeHost(host);
      const previous = firstSeenAt.get(host);

      // ---- The conflict rule ----------------------------------------------
      //
      // TWO DUPLICATE CASES, TREATED DIFFERENTLY, because they carry completely
      // different risk.
      //
      // Same host, SAME IP, twice: harmless restatement. First wins, exactly
      // like /etc/hosts, and it earns a warning only so a generated file that
      // doubles every entry is visible.
      //
      // Same host, DIFFERENT IPs: we do not know which box serves that site,
      // and /etc/hosts' first-wins rule would pick one silently. A wrong-but-
      // plausible 200 from the wrong box is the hardest failure in this whole
      // feature to notice — it does not error, it does not time out, it just
      // measures a different website. So the host is removed from the map
      // entirely and routes publicly, which is always correct if slower.
      //
      // The removal poisons the whole www-family (both `foo.com` and
      // `www.foo.com`), not just the spelling that collided: the ambiguity is
      // about which server hosts THE SITE, and the other spelling would
      // otherwise be reachable through the www fallback below.
      //
      // NOT HYPOTHETICAL: the map first supplied for this feature listed
      // www.industrialworld360.com under both 10.0.61.203 and 10.0.49.183.
      if (previous && previous.ip !== ip) {
        const claimed = conflicts.get(family) ?? [previous.ip];

        if (!claimed.includes(ip)) {
          claimed.push(ip);
        }

        conflicts.set(family, claimed);
        warnings.push(
          `line ${lineNumber}: "${host}" is claimed by ${claimed.join(" and ")} ` +
            `(first at line ${previous.line}) — NOT routed privately, ` +
            `resolve which server hosts it`
        );
        continue;
      }

      if (previous) {
        warnings.push(
          `line ${lineNumber}: "${host}" repeats the same IP as line ${previous.line} — ignored`
        );
        continue;
      }

      firstSeenAt.set(host, { ip, line: lineNumber });
      entries.set(host, ip);
    }
  }

  // Applied after the whole file is read, so a conflict on line 900 still
  // removes the entry made on line 12.
  for (const family of conflicts.keys()) {
    entries.delete(family);
    entries.delete(`www.${family}`);
  }

  return { entries, conflicts, warnings };
}

export type PrivateHostMapSnapshot = {
  file: string;
  present: boolean;
  mtimeMs: number | null;
  loadedAt: number | null;
  entryCount: number;
  hostsByIp: Record<string, number>;
  conflicts: Record<string, string[]>;
  warnings: string[];
};

type LoadedMap = {
  parsed: ParsedHostMap;
  file: string;
  mtimeMs: number | null;
  sizeBytes: number | null;
  loadedAt: number;
};

let loaded: LoadedMap | null = null;
let lastStatAt = 0;

function emptyParse(): ParsedHostMap {
  return { entries: new Map(), conflicts: new Map(), warnings: [] };
}

// Re-read the file when it changes, checked at most once per reloadSeconds.
//
// A sync stat once a minute costs nothing and is deliberately preferred to
// fs.watch, which is unreliable across a Docker bind mount and — worse — breaks
// permanently when an in-place `vi` save replaces the inode. Ops editing the map
// on the box is the expected workflow, so the reload path has to survive the way
// they actually edit.
function ensureLoaded(file: string, reloadSeconds: number): LoadedMap {
  const now = Date.now();

  if (loaded && loaded.file === file && now - lastStatAt < reloadSeconds * 1000) {
    return loaded;
  }

  lastStatAt = now;

  let mtimeMs: number | null = null;
  let sizeBytes: number | null = null;

  try {
    const stat = statSync(file);

    mtimeMs = stat.mtimeMs;
    sizeBytes = stat.size;
  } catch {
    // Missing file is a supported state, not an error: it is what a laptop dev
    // run looks like, and the feature is simply inert without it. Keep the
    // existing empty state rather than re-allocating one per poll.
    const alreadyKnownMissing =
      loaded !== null && loaded.file === file && loaded.mtimeMs === null;

    if (!alreadyKnownMissing) {
      loaded = {
        parsed: emptyParse(),
        file,
        mtimeMs: null,
        sizeBytes: null,
        loadedAt: now
      };
    }

    return loaded as LoadedMap;
  }

  if (
    loaded !== null &&
    loaded.file === file &&
    loaded.mtimeMs === mtimeMs &&
    loaded.sizeBytes === sizeBytes
  ) {
    return loaded;
  }

  try {
    loaded = {
      parsed: parseHostsFile(readFileSync(file, "utf8")),
      file,
      mtimeMs,
      sizeBytes,
      loadedAt: now
    };
  } catch (error) {
    // A read failure AFTER a successful load keeps the old map rather than
    // silently emptying it: a transient EBUSY mid-edit must not push 650 sites
    // back onto the public path.
    if (loaded && loaded.file === file && loaded.mtimeMs !== null) {
      return loaded;
    }

    loaded = {
      parsed: {
        ...emptyParse(),
        warnings: [
          `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`
        ]
      },
      file,
      mtimeMs,
      sizeBytes,
      loadedAt: now
    };
  }

  return loaded;
}

// The private address for a hostname, or null when it is not mapped.
//
// Callers pass a URL's HOSTNAME, never its host: the map carries no ports, so
// looking up "example.com:8080" would miss every time.
//
// The www fallback exists because the supplied map is inconsistent about it —
// four of the seven blocks list only `www.` forms while the others list both —
// and resolveSampleTarget can legitimately probe either spelling of the same
// site. It reuses normalizeHost, i.e. the www LABEL only, never an arbitrary
// subdomain: probing shop.example.com when the map described example.com would
// be measuring a different site.
export function privateIpForHost(
  hostname: string,
  options: { file: string; reloadSeconds: number }
): PrivateHostMatch | null {
  const { parsed } = ensureLoaded(options.file, options.reloadSeconds);

  if (parsed.entries.size === 0) {
    return null;
  }

  const host = hostname.toLowerCase();
  const family = normalizeHost(host);

  // Conflicted families never route privately, whichever spelling was asked
  // for. Checked explicitly rather than relying on the entries deletion, so the
  // rule survives someone later "fixing" the parser to keep both.
  if (parsed.conflicts.has(family)) {
    return null;
  }

  const exact = parsed.entries.get(host);

  if (exact) {
    return { ip: exact, family: ipFamily(exact), matchedVia: "exact" };
  }

  for (const candidate of [`www.${family}`, family]) {
    const found = parsed.entries.get(candidate);

    if (found) {
      return { ip: found, family: ipFamily(found), matchedVia: "www-fallback" };
    }
  }

  return null;
}

export function privateHostMapSnapshot(options: {
  file: string;
  reloadSeconds: number;
}): PrivateHostMapSnapshot {
  const state = ensureLoaded(options.file, options.reloadSeconds);
  const hostsByIp: Record<string, number> = {};

  for (const ip of state.parsed.entries.values()) {
    hostsByIp[ip] = (hostsByIp[ip] ?? 0) + 1;
  }

  return {
    file: state.file,
    present: state.mtimeMs !== null,
    mtimeMs: state.mtimeMs,
    loadedAt: state.loadedAt,
    entryCount: state.parsed.entries.size,
    hostsByIp,
    conflicts: Object.fromEntries(state.parsed.conflicts),
    warnings: state.parsed.warnings
  };
}

// One line at boot saying what was loaded, and every problem with it.
//
// WHY AT BOOT rather than on first use. The map is infrastructure topology edited by
// hand on the box: a typo, a hostname claimed by two IPs, or a file mounted at the
// wrong path is an ops mistake, and the moment to surface it is the restart that
// followed the edit — not silently at the first probe of an affected site, hours later,
// where it reads as a site problem.
//
// Warnings are logged INDIVIDUALLY at warn level rather than as one array field, so a
// log search for a hostname finds the line that explains it.
export function logPrivateHostMapStatus(
  logger: { info: LogFn; warn: LogFn },
  options: { enabled: boolean; file: string; reloadSeconds: number }
): void {
  const snapshot = privateHostMapSnapshot(options);
  const ipCount = Object.keys(snapshot.hostsByIp).length;

  logger.info(
    {
      private_route_enabled: options.enabled,
      map_file: snapshot.file,
      map_present: snapshot.present,
      mapped_hosts: snapshot.entryCount,
      private_ips: ipCount,
      hosts_by_ip: snapshot.hostsByIp,
      conflicts: Object.keys(snapshot.conflicts).length,
      warnings: snapshot.warnings.length
    },
    options.enabled
      ? "private host map loaded — health checks for these hosts will use their private VPC address"
      : "private host map loaded but PRIVATE_ROUTE_ENABLED is not true — every check still uses the public internet"
  );

  for (const warning of snapshot.warnings) {
    logger.warn({ map_file: snapshot.file }, `private host map: ${warning}`);
  }
}

type LogFn = (fields: Record<string, unknown>, message: string) => void;

// Test seam, matching resetObservedAlpn() / resetHostRateLimiter().
export function resetPrivateHostMap(): void {
  loaded = null;
  lastStatAt = 0;
}
