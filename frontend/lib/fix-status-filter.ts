// Which URLs the Fix modal's status chips show.
//
// The chips (301/302/307/308/404) sit directly above the URL list and, until
// v1.52, filtered nothing: the selection lived inside PatternVerifyPanel while
// the list lived in the results page, so clicking 404 restyled the chip and
// changed the delete target but left every status showing in the rows below.
//
// Extracted here rather than left inline so the subset rule is testable without
// mounting the modal — the counts on the chips and the rows in the list have to
// agree, and that agreement is the whole point of the fix.

export type StatusFilterable = {
  // Mirrors NumberLike from lib/api: pg returns bigints as strings, so a row's
  // status can arrive as 404 or "404", and an unchecked row has none at all.
  http_status: number | string | null | undefined;
};

// Normalise the wire value to a number, or null when there isn't one.
export function candidateStatus(
  candidate: StatusFilterable
): number | null {
  if (candidate.http_status === null || candidate.http_status === undefined) {
    return null;
  }

  const value =
    typeof candidate.http_status === "number"
      ? candidate.http_status
      : Number.parseInt(candidate.http_status, 10);

  return Number.isFinite(value) ? value : null;
}

// An EMPTY selection means "no filter" — every candidate — matching the "All"
// chip and the same convention the Delete Problem URLs dialog uses.
//
// Candidates with no status are the INFERRED rows: they matched the pattern but
// were never HTTP-checked, so no status chip can honestly claim them. They drop
// out of a filtered view rather than being shown under a code they might not
// return, which would be the sampled-vs-verified confusion this modal exists to
// remove.
export function filterByStatus<T extends StatusFilterable>(
  candidates: T[],
  statuses: Set<number>
): T[] {
  if (statuses.size === 0) {
    return candidates;
  }

  return candidates.filter((candidate) => {
    const status = candidateStatus(candidate);

    return status !== null && statuses.has(status);
  });
}
