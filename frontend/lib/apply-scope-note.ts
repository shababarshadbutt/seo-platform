// "10 URLs updated" was true and still misleading (v1.75).
//
// The Accept button promised 579,034. The rewrite opened 4 of the pattern's 187
// files, because the inline apply path scoped its scan to the files the ten
// confirmed sampled rows named. Both numbers were correct about different
// things, and nothing on screen connected them — so a lost-URL bug read as a
// clean success and took a code trace to explain.
//
// The scope is now said out loud whenever the rewrite reached only part of the
// pattern. This does not decide whether something is wrong; it puts the one
// fact next to the count that makes a disagreement checkable.
export function applyScopeNote(input: {
  filesScanned: number | null | undefined;
  patternFileCount: number | null | undefined;
}): string | null {
  const scanned = input.filesScanned ?? 0;
  const total = input.patternFileCount ?? 0;

  // Nothing useful to compare. A zero total means the pattern has no recorded
  // occurrence rows (older sessions), where "of 0 files" would be nonsense.
  if (scanned <= 0 || total <= 0) {
    return null;
  }

  // Full coverage is the normal case and needs no caveat — saying "across 187
  // of 187 files" on every apply would train the reader to skip the line, which
  // is exactly the line that matters when the numbers do differ.
  if (scanned >= total) {
    return null;
  }

  return `across ${formatCount(scanned)} of ${formatCount(total)} files`;
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}
