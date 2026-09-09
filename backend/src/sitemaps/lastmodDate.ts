// Date-only lastmod values (YYYY-MM-DD), the same truncation of ISO 8601 every
// other publish/cleaner/index path in this codebase already inlines as
// `new Date().toISOString().slice(0, 10)` — centralised here because the
// Lastmod Updater is the first feature to also need to VALIDATE an
// operator-supplied date string, not just produce today's.

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function todayLastmodDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// A syntactically valid YYYY-MM-DD date that round-trips through Date — catches
// both malformed strings ("2026-13-40") and non-date input, without pulling in
// a date library for one check.
export function isValidLastmodDate(value: string): boolean {
  if (!DATE_ONLY.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}
