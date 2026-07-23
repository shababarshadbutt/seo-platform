// Pure ZIP-cache freshness decision, kept in its own side-effect-free module
// (no DB / queue imports) so it can be unit-tested without opening handles.
//
// A cached ZIP (generated at `zipGeneratedAt`) still reflects the session's
// files (last mutated at `filesMutatedAt`) only if it was generated STRICTLY
// AFTER the last post-completion mutation. The strict comparison + build-start
// stamping in preGenerateZipJob is what closes the race where a build already
// in flight recorded a pre-edit snapshot (v1.42).
//   filesMutatedAt null  → no post-completion mutation, any cache is fine.
//   zipGeneratedAt null  → no (valid) cache.
export function isZipCacheFresh(
  zipGeneratedAt: Date | string | null,
  filesMutatedAt: Date | string | null
): boolean {
  if (!filesMutatedAt) {
    return true;
  }

  if (!zipGeneratedAt) {
    return false;
  }

  return (
    new Date(zipGeneratedAt).getTime() > new Date(filesMutatedAt).getTime()
  );
}
