// Visibility rule for the pattern table's Fix button.
//
// The button keys off the pattern's STATUS alone, not off whether a redirect
// happened to land in the ≤ sample_size sampled URLs: a Broken pattern whose
// tiny sample is all 404s (e.g. total_urls = 1) still needs its Fix entry
// point, and a Healthy pattern hides Fix even when its sample contains a
// redirect — per the SEO team's spec, only Broken/Warning are fixable.
export type PatternStatus = "GOOD" | "WARNING" | "BAD" | "UNKNOWN";

export function showFixButton(row: { status: PatternStatus }): boolean {
  return row.status === "BAD" || row.status === "WARNING";
}
