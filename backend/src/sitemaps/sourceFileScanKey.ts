import { pool } from "../db/pool.js";
import { canonicalFingerprint } from "./patternStructureJobClaim.js";

import type { ResolvedStructureFilter } from "./structureClusters.js";

// The cache key for one structure-scoped source-file scan.
//
// STALE ENTRIES ARE UNREACHABLE, NEVER DELETED. This is the whole design, and it
// is deliberate: the key contains a hash of the pattern's current file set, so
// the moment any file is added, replaced or removed, every previously cached
// answer for that pattern lands under a key nobody will ever ask for again. It
// expires on its own via the store's TTL backstop.
//
// Do NOT "fix" this by adding explicit invalidation on the mutation paths. There
// are six of them today (rename, redirect-fix, bulk replace, transform, URL
// delete, trailing-slash) and a seventh will be added eventually; every one of
// them would have to remember to call it, and the one that forgets serves a file
// list that no longer matches disk — which is exactly the class of bug v1.80 and
// v1.81 were both spent chasing. Making correctness fall out of the key means
// there is nothing to forget.

const KEY_PREFIX = "sourcefiles:v1";

// Bump when the SHAPE of the cached value changes (a new field on the result, a
// different meaning for an existing one). Old entries then become unreachable
// for free, exactly like a file-set change, instead of being deserialised into a
// shape the reader no longer expects.
export type SourceFileScanCacheKeyInput = {
  patternId: string;
  filesVersion: string;
  resolvedFilters: ResolvedStructureFilter[];
};

export function sourceFileScanCacheKey({
  patternId,
  filesVersion,
  resolvedFilters
}: SourceFileScanCacheKeyInput): string {
  // canonicalFingerprint sorts arrays and object keys, so two encodings of the
  // same scope — the same filters in a different order, say — produce one key
  // and share one scan.
  //
  // NOT fingerprintFilters() from routes/sessions.ts, even though that is the
  // other thing in this codebase that hashes a filter list. It deliberately does
  // NOT sort: its comment explains that changing the job fingerprint would make
  // a retry-after-timeout look like a brand-new operation and re-apply an edit
  // that had already committed. That constraint is about hash STABILITY across
  // deploys and has nothing to do with a cache, where inheriting order
  // sensitivity would just quietly cost hits.
  const filterHash = canonicalFingerprint("SOURCE_FILE_SCAN", {
    structure_filter: resolvedFilters
  });

  return `${KEY_PREFIX}:${patternId}:${filesVersion}:${filterHash}`;
}

// A hash of the pattern's current file set, standing in for the "source version"
// that sitemap_files has no column for.
//
// WHY DERIVED RATHER THAN STORED. There is no updated_at on sitemap_files, but
// every edit in this app is copy-on-write: it writes a new blob and repoints
// sitemap_files.filename at it (see buildRenamedStoredFilename and its siblings
// in filenames.ts). So the set of (id, filename) pairs changes on exactly the
// events that invalidate a scan — a file added, replaced, or soft-deleted — and
// nothing else. Adding a column would mean every mutation path has to remember
// to bump it; reading the rows means none of them do.
//
// Scoped to the pattern's own source_role because that is the population
// scopedPatternSourceFileBreakdown itself queries, so the version cannot claim a
// file set the scan would not have looked at.
export async function patternFilesVersion(
  sessionId: string,
  sourceRole: string
): Promise<string> {
  const files = await pool.query<{ id: string; filename: string }>(
    `
      SELECT id, filename
      FROM sitemap_files
      WHERE session_id = $1 AND source_role = $2 AND is_deleted = false
      ORDER BY id ASC
    `,
    [sessionId, sourceRole]
  );

  return canonicalFingerprint("SOURCE_FILE_SET", {
    files: files.rows.map((file) => `${file.id}:${file.filename}`)
  });
}
