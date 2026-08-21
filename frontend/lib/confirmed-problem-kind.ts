// Is every confirmed problem in this selection something that could be FIXED
// instead of deleted?
//
// WHY THIS DECIDES A BUTTON'S COLOUR. The verify panel offered a prominent red
// "Review & delete 579,024 confirmed problem URLs" on a pattern whose problems
// were all 301s. A 301 redirects somewhere: deleting it discards a page that
// works, while rewriting it to its destination is the whole point of the tool. A
// 404 has nowhere to go, so deleting is the only action available there.
//
// The count sums every problem status because an empty chip selection means "all
// of them", so the destructive button claimed the entire population without
// distinguishing the two cases.
//
// Extracted because the panel has no test harness and this is the part that
// decides how loudly a destructive action is offered.

// The only confirmed problem with no destination to rewrite to.
export const NOT_FIXABLE_STATUS = 404;

export function confirmedProblemKind(input: {
  // The statuses the delete would target — an explicit chip selection, or every
  // problem status when nothing is selected.
  statuses: number[];
  // Confirmed count per status.
  counts: Map<number, number>;
}): {
  total: number;
  notFixable: number;
  // True when everything the delete would take could be fixed instead.
  allFixable: boolean;
} {
  const total = input.statuses.reduce(
    (sum, code) => sum + (input.counts.get(code) ?? 0),
    0
  );
  // Only counted when 404 is actually in the selection: a 404 count that the
  // delete would not touch must not make a redirect-only delete look dangerous.
  const notFixable = input.statuses.includes(NOT_FIXABLE_STATUS)
    ? input.counts.get(NOT_FIXABLE_STATUS) ?? 0
    : 0;

  return {
    total,
    notFixable,
    // Nothing to delete is not "all fixable" — with total 0 the button is
    // disabled anyway, and claiming otherwise would put the reassurance copy on
    // a pattern that has no problems at all.
    allFixable: total > 0 && notFixable === 0
  };
}
