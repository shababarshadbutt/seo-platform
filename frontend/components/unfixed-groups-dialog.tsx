"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";

import {
  getShapeRules,
  saveShapeRule,
  type ShapeRuleRecord,
  type SkippedShape
} from "@/lib/api";
import {
  applyBlockedReason,
  buildSkippedGroupRows,
  describeApplyScope,
  describeReach,
  describeRule,
  describeUnmatchedRule,
  partitionSkippedGroupRows,
  selectedReach,
  unresolvedSummary,
  type ShapeRuleState,
  type SkippedGroupRow
} from "@/lib/skipped-group-rows";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";

// The way out of "10,427,499 URLs were left unchanged" (v1.84).
//
// v1.81 taught the fix report to name the groups it could not touch, and then
// offered only Dismiss. On the reported session the pattern had swallowed
// several unrelated URL families, so their confirmed pairs disagreed, no rule
// could be derived for the pattern as a whole, and a fix reached 8 URLs out of
// ten million. The operator could SEE the right rewrite for 285,851 of them and
// had no way to say so. This is that way.
//
// WRITTEN FOR SEO OPERATORS. Nobody is asked to write a rule. They edit real
// URLs into what those URLs should become, and the server distils the rule from
// the pairs with the same deriveRedirectRule a probe would use — so a rule
// somebody typed and a rule that was measured are the same kind of object, and
// neither can express something the rewriter would refuse to honour.
//
// AND SINCE v1.86 IT IS A VIEW OF THE REMAINDER, not a fresh start every time.
// Three things made a second pass repeat the first:
//
//   * it never read the saved rules back, so a group that had already been
//     answered read "Nothing yet" exactly like one nobody had touched;
//   * select-all ticked those answered groups too, so a bulk save overwrote
//     answers that were already correct;
//   * Apply closed the dialog and the group list never refreshed, so seeing what
//     was left meant finding the next toast.
//
// The first of those was the one that could loop forever. The save endpoint
// stores a rule for every shape asked for WITHOUT checking that it transforms
// each one — deliberately, because the next coverage report catches it — so a
// group the rule cannot match reappears with its count intact. Unable to tell
// that group from an unanswered one, an operator retypes the rule that already
// failed. The dialog now says which groups carry a rule, and says when one of
// them came back anyway.

type Residue = {
  shapes: SkippedShape[];
  skippedInScope: number | null;
  shapesTruncated?: boolean;
  measuredAt?: string | null;
};

type Props = {
  sessionId: string;
  patternId: string;
  template: string;
  shapes: SkippedShape[];
  // The apply's own count of what it left behind, and whether the group list was
  // capped. Reported rather than summed from `shapes` — the backend caps the
  // histogram at its 25 biggest groups, so a sum would under-report and imply the
  // list is complete.
  skippedInScope?: number | null;
  shapesTruncated?: boolean;
  // WHEN the residue on screen was measured — the apply that produced it. The
  // caveat on an answered group that came back anyway is only honest if the rule
  // predates the measurement, so this is what makes that claim checkable rather
  // than assumed. Null when unknown, and then no such claim is made.
  measuredAt?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Re-run the fix and RESOLVE WITH WHAT IS STILL LEFT (v1.86). The dialog still
  // does not apply anything itself — saving a rule and applying it stay separate
  // acts, and the apply already knows how to pick up every agreed rule for the
  // pattern — but it now stays open and shows the new remainder, so one dialog
  // carries fix → see what is left → fix again. Resolving null means the outcome
  // is not known here (a queued apply that has not landed), which the dialog says
  // rather than implying the list is current.
  onApply: () => Promise<Residue | null>;
};

// A stored rule as the row model wants it.
//
// KEEPS THE THREE WORDS APART. Migrations 051 and 053 spent two releases
// separating fetched from inferred from asserted, and record that an earlier
// conflation took two releases to undo. `operator` is an assertion, `sampled` is a
// measurement, and an unagreed row is a measurement that came back inconsistent —
// which is exactly the state that produces these shortfalls, so it must not be
// dressed up as an answer.
function toRuleState(record: ShapeRuleRecord): ShapeRuleState | null {
  // CHECKED FIRST, because a "leave these alone" row has no rule and does not
  // agree to anything — it would fall straight through the guard below and be
  // dropped, putting the group back under "still needs an answer" and losing the
  // one thing v1.87 exists to record.
  if (record.source === "no_change") {
    return { kind: "no-change", authoredAt: record.authored_at ?? null };
  }

  if (!record.rule || !record.agreed) {
    return null;
  }

  return {
    kind: record.source === "operator" ? "operator" : "measured",
    summary: describeRule(record.rule),
    // Carried through so the "this rule may not fit" caveat can tell a rule an
    // apply has already failed to match from one saved moments ago.
    authoredAt: record.authored_at ?? null
  };
}

export function UnfixedGroupsDialog({
  sessionId,
  patternId,
  template,
  shapes,
  skippedInScope = null,
  shapesTruncated = false,
  measuredAt = null,
  open,
  onOpenChange,
  onApply
}: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rules, setRules] = useState<Map<string, ShapeRuleState>>(new Map());
  const [editing, setEditing] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [loadingRules, setLoadingRules] = useState(false);
  const [applying, setApplying] = useState(false);
  // What the last in-dialog apply reported, so pressing Fix has a visible result
  // instead of the dialog simply redrawing with fewer rows.
  const [applyNote, setApplyNote] = useState("");
  const [showResolved, setShowResolved] = useState(false);
  const [showLeftAsIs, setShowLeftAsIs] = useState(false);
  // The residue is STATE, not the prop, so an apply can replace it in place. The
  // prop seeds it and remains the truth for a freshly opened dialog.
  const [residue, setResidue] = useState<Residue>({
    shapes,
    skippedInScope,
    shapesTruncated,
    measuredAt
  });

  const loadRules = useCallback(async () => {
    setLoadingRules(true);

    try {
      const records = await getShapeRules(sessionId, patternId);

      setRules(() => {
        const next = new Map<string, ShapeRuleState>();

        for (const record of records) {
          const state = toRuleState(record);

          if (state) {
            next.set(record.shape, state);
          }
        }

        return next;
      });
    } catch {
      // A pattern with no rules yet is the common case and not an error worth a
      // banner; a genuine failure degrades to the pre-v1.86 behaviour of showing
      // every group as unanswered, which is wrong but not misleading — the rows
      // still say what they say and saving still works.
    } finally {
      setLoadingRules(false);
    }
  }, [patternId, sessionId]);

  // Reopening on a different pattern must not show the previous one's answers.
  useEffect(() => {
    if (!open) {
      return;
    }

    setSelected(new Set());
    setRules(new Map());
    setEditing(null);
    setDrafts([]);
    setError("");
    setApplyNote("");
    setShowResolved(false);
    setShowLeftAsIs(false);
    setResidue({ shapes, skippedInScope, shapesTruncated, measuredAt });
    void loadRules();
    // shapes/skippedInScope/shapesTruncated are deliberately NOT dependencies: they
    // seed the residue on open and must not clobber a refresh mid-session, which is
    // what re-running this on a new prop identity would do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, patternId, loadRules]);

  const rows = useMemo(
    () => buildSkippedGroupRows(residue.shapes, rules),
    [residue.shapes, rules]
  );
  const { unresolved, resolved, leftAsIs } = useMemo(
    () => partitionSkippedGroupRows(rows),
    [rows]
  );
  const blocked = applyBlockedReason(rows);
  const busy = saving || applying;
  // Select-all covers the OUTSTANDING groups only. Ticking chooses what an edit is
  // saved for, so including groups that already have the right answer would let one
  // bulk save overwrite work that was already done — the opposite of what a second
  // pass is for. Since v1.87 that also excludes groups marked "leave as it is",
  // which are answered too; the answer is just that nothing should happen.
  const allSelected =
    unresolved.length > 0 &&
    unresolved.every((row) => selected.has(row.shape));
  const editingRow = rows.find((row) => row.shape === editing) ?? null;
  const selectedCount = selected.size;
  // Ticked groups that a bulk "leave as it is" would actually change. A group
  // already marked is excluded so the button's count never promises work it will
  // not do — the same reason the footer counts what the apply covers rather than
  // what is ticked.
  const selectedMarkable = useMemo(
    () =>
      rows.filter(
        (row) => selected.has(row.shape) && row.rule.kind !== "no-change"
      ),
    [rows, selected]
  );

  function openEditor(shape: string, examples: string[]) {
    setEditing(shape);
    // Seeded with the URLs as they are now, so the operator EDITS rather than
    // types. An empty box would be a blank-page problem on a task whose answer
    // is a small change to something already on screen.
    setDrafts([...examples]);
    setError("");
  }

  function toggle(shape: string) {
    setSelected((current) => {
      const next = new Set(current);

      if (next.has(shape)) {
        next.delete(shape);
      } else {
        next.add(shape);
      }

      return next;
    });
  }

  async function save(bulk: boolean) {
    if (!editingRow) {
      return;
    }

    setSaving(true);
    setError("");

    try {
      const pairs = editingRow.examples.map((source, index) => ({
        source,
        dest: drafts[index] ?? source
      }));
      // The shapes this edit resolves: just the group being edited, or every
      // ticked group when the operator chose the bulk action. One request either
      // way, so a bulk set cannot land half-applied.
      const targets = bulk
        ? rows.filter((row) => selected.has(row.shape)).map((row) => row.shape)
        : [editingRow.shape];
      const result = await saveShapeRule(sessionId, patternId, {
        shapes: targets,
        pairs
      });

      // `rule` is nullable on the response since v1.87 (the leave-as-it-is
      // answers carry none), but this path sent pairs, so the server derived one
      // or refused with a 400 we would have caught. Guarding rather than asserting
      // because a summary is what the row renders, and "" would read as a rule
      // that says nothing.
      const summary = result.rule ? describeRule(result.rule) : null;

      if (summary) {
        setRules((current) => {
          const next = new Map(current);

          for (const target of result.shapes ?? targets) {
            next.set(target, {
              kind: "operator",
              summary,
              // Stamped now, which is AFTER the measurement on screen — so the
              // "this rule may not fit" caveat correctly stays silent until an
              // apply has actually run against it.
              authoredAt: new Date().toISOString()
            });
          }

          return next;
        });
      }
      // Saving is consent to include it — anything else means ticking the row a
      // second time to say what you just said.
      setSelected((current) => {
        const next = new Set(current);

        for (const target of targets) {
          next.add(target);
        }

        return next;
      });
      setEditing(null);
    } catch (nextError) {
      // The message that matters most is the server's refusal when the edits
      // describe more than one change: it names the problem and what to do.
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Could not save that rule."
      );
    } finally {
      setSaving(false);
    }
  }

  // "LEAVE AS IT IS" — and its undo (v1.87).
  //
  // The group's URLs are already correct, so there is nothing to edit and no rule
  // to derive. The apply was always going to leave them alone; what this records is
  // that somebody DECIDED so, which is the only thing that keeps the group out of
  // "still needs an answer" on the next pass.
  //
  // `shapesToMark` is passed in rather than read off `selected` so the per-row
  // button and the bulk button are the same code path — one request either way, so
  // a bulk mark cannot land half-applied, exactly as with the bulk save above.
  async function markNoChange(shapesToMark: string[], noChange: boolean) {
    if (shapesToMark.length === 0) {
      return;
    }

    setSaving(true);
    setError("");

    try {
      await saveShapeRule(sessionId, patternId, {
        shapes: shapesToMark,
        no_change: noChange
      });

      setRules((current) => {
        const next = new Map(current);

        for (const target of shapesToMark) {
          if (noChange) {
            next.set(target, {
              kind: "no-change",
              authoredAt: new Date().toISOString()
            });
          } else {
            // Undoing removes the entry entirely rather than storing a "not
            // marked" state, matching the server, which DELETEs the row: the
            // absence of an answer is already how "nobody has said anything about
            // this shape" is spelled, in both halves.
            next.delete(target);
          }
        }

        return next;
      });
      // Untick what was just marked. Selection chooses what the NEXT edit applies
      // to, and a group that has been settled has no next edit — leaving it ticked
      // would quietly include it in the following bulk save.
      setSelected((current) => {
        const next = new Set(current);

        for (const target of shapesToMark) {
          next.delete(target);
        }

        return next;
      });

      if (editing && shapesToMark.includes(editing)) {
        setEditing(null);
      }
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Could not save that decision."
      );
    } finally {
      setSaving(false);
    }
  }

  // Fix, then show what is STILL left — without closing (v1.86).
  async function apply() {
    setApplying(true);
    setError("");
    setApplyNote("");

    try {
      const next = await onApply();

      if (!next) {
        // A queued apply whose outcome is not known here. Saying so is the honest
        // answer: silently leaving the old list on screen would present a stale
        // remainder as a fresh one.
        setApplyNote(
          "The fix is running in the background. This list will not update until it finishes — reopen it then to see what is left."
        );

        return;
      }

      // Stamped NOW when the caller did not date it: this residue was measured by
      // the apply that just returned, and that timestamp is what lets a rule saved
      // before it be told apart from one saved after.
      setResidue({
        ...next,
        measuredAt: next.measuredAt ?? new Date().toISOString()
      });
      setSelected(new Set());
      setEditing(null);
      // Re-read the rules too: the apply may have consumed some, and a group that
      // came back despite having one is precisely what the caveat needs to flag.
      await loadRules();

      const remaining = next.shapes.length;

      setApplyNote(
        remaining === 0
          ? "Every group in this pattern is fixed. Download the sitemap to confirm the change."
          : `${remaining} group${remaining === 1 ? "" : "s"} ${
              remaining === 1 ? "is" : "are"
            } still unfixed.`
      );
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "The fix failed to run."
      );
    } finally {
      setApplying(false);
    }
  }

  function renderRow(row: SkippedGroupRow, selectable: boolean) {
    const caveat = describeUnmatchedRule(row, residue.measuredAt);

    return (
      <tr key={row.shape} className="border-t align-top">
        <td className="px-3 py-2">
          {selectable ? (
            <input
              type="checkbox"
              aria-label={`Select ${row.shape}`}
              className="mt-1 h-4 w-4 rounded border-slate-300"
              checked={selected.has(row.shape)}
              disabled={busy}
              onChange={() => toggle(row.shape)}
            />
          ) : null}
        </td>
        <td className="max-w-[280px] px-3 py-2">
          <span className="block break-all font-mono text-xs">
            {row.examples[0] ?? row.shape}
          </span>
          {/* THE GROUP'S OWN PATTERN, on screen rather than in a tooltip. The
              example says which URLs these are; the shape says what they have in
              common, which is what the rule has to describe. It was reachable
              only by hovering the cell. */}
          <span className="mt-0.5 block break-all font-mono text-[11px] text-muted-foreground">
            {row.shape}
          </span>
        </td>
        <td className="whitespace-nowrap px-3 py-2 font-medium">
          {describeReach(row)}
        </td>
        <td className="px-3 py-2">
          {row.rule.kind === "none" ? (
            <span className="text-muted-foreground">
              Nothing yet — these stay as they are
            </span>
          ) : row.rule.kind === "no-change" ? (
            // A DECISION, not an absence — and it has to read differently from
            // "Nothing yet" above, which is the state it was indistinguishable
            // from. Slate rather than amber: nothing here is outstanding.
            <span className="space-y-0.5">
              <span className="block text-xs text-slate-600">
                Already correct — left unchanged
              </span>
              <span className="block text-[11px] uppercase tracking-wide text-muted-foreground">
                You marked this
              </span>
            </span>
          ) : (
            <span className="space-y-0.5">
              <span className="block font-mono text-xs">
                {row.rule.summary}
              </span>
              <span className="block text-[11px] uppercase tracking-wide text-muted-foreground">
                {row.rule.kind === "operator" ? "You set this" : "Measured"}
              </span>
              {caveat ? (
                <span className="block text-[11px] text-amber-700">
                  {caveat}
                </span>
              ) : null}
            </span>
          )}
        </td>
        <td className="whitespace-nowrap px-3 py-2 text-right">
          {row.rule.kind === "no-change" ? (
            // THE UNDO. The mark is persisted, so it has to be reversible from the
            // same place it was made — otherwise a mis-click is permanent and the
            // group is invisible under a collapsed section.
            <button
              type="button"
              className="text-xs font-semibold text-primary underline hover:text-primary/80 disabled:no-underline disabled:opacity-50"
              disabled={busy}
              onClick={() => void markNoChange([row.shape], false)}
            >
              Needs a fix
            </button>
          ) : (
            <span className="inline-flex items-center gap-3">
              <button
                type="button"
                className="text-xs font-semibold text-primary underline hover:text-primary/80 disabled:no-underline disabled:opacity-50"
                disabled={busy}
                onClick={() => openEditor(row.shape, row.examples)}
              >
                {row.rule.kind === "none" ? "Set the result" : "Edit"}
              </button>
              {/* BESIDE "Set the result", as asked for, and deliberately NOT
                  styled like it. This is the answer for a group that needs no
                  work, so it must not compete with the primary action for
                  attention — slate, no underline until hover. */}
              <button
                type="button"
                className="text-xs font-medium text-slate-500 hover:text-slate-700 hover:underline disabled:opacity-50"
                disabled={busy}
                title="These URLs are already correct — record that and stop listing this group as outstanding"
                onClick={() => void markNoChange([row.shape], true)}
              >
                Leave as it is
              </button>
            </span>
          )}
        </td>
      </tr>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Unfixed URL groups</DialogTitle>
        </DialogHeader>

        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">
            These URLs are in{" "}
            <code className="font-mono text-xs">{template}</code> but the fix
            left them alone, because nothing yet says where they should go. Set
            the result for a group, then run the fix again.
          </p>
          <p className="text-sm font-medium">
            {unresolvedSummary({
              skippedInScope: residue.skippedInScope,
              rows,
              shapesTruncated: residue.shapesTruncated
            })}
          </p>
        </div>

        {applyNote ? (
          <p className="rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-sm">
            {applyNote}
          </p>
        ) : null}

        {/* THE BULK MARK, and it lives HERE rather than beside the bulk save
            (v1.87). That one sits inside the editor panel, which only exists once
            a group is being edited — right for an action that saves an edit, wrong
            for this one: marking a group already-correct involves no editing at
            all, so requiring an editor to be open first would be a step that
            exists only to reach a button.

            Offered from ONE selected group upward, unlike the bulk save. The bulk
            save needs two before it does anything the per-row button does not; a
            selection bar here is also how the operator confirms what is ticked
            before acting on it. */}
        {selectedMarkable.length > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
            <p className="text-xs text-slate-600">
              {selectedMarkable.length} group
              {selectedMarkable.length === 1 ? "" : "s"} selected ·{" "}
              {selectedReach(rows, selected).toLocaleString("en-US")} URLs
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              title="Record that these groups are already correct, so they stop being listed as outstanding"
              onClick={() =>
                void markNoChange(
                  selectedMarkable.map((row) => row.shape),
                  true
                )
              }
            >
              {saving ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : null}
              Leave all {selectedMarkable.length} as they are
            </Button>
          </div>
        ) : null}

        <div className="max-h-[420px] overflow-y-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted/60 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="w-8 px-3 py-2">
                  {/* Select all — the "fix all" entry point. Indeterminate when
                      only some are ticked, so it never claims a state it is
                      not in. It covers the OUTSTANDING groups only; see
                      allSelected above for why. */}
                  <input
                    type="checkbox"
                    aria-label="Select every unfixed group"
                    className="h-4 w-4 rounded border-slate-300"
                    checked={allSelected}
                    disabled={busy || unresolved.length === 0}
                    ref={(node) => {
                      if (node) {
                        node.indeterminate =
                          selected.size > 0 && !allSelected;
                      }
                    }}
                    onChange={() =>
                      setSelected(
                        allSelected
                          ? new Set()
                          : new Set(unresolved.map((row) => row.shape))
                      )
                    }
                  />
                </th>
                <th className="px-3 py-2">Example URL</th>
                <th className="px-3 py-2">Affects</th>
                <th className="px-3 py-2">What will happen</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {loadingRules && rows.length > 0 ? (
                <tr className="border-t">
                  <td colSpan={5} className="px-3 py-2 text-xs text-muted-foreground">
                    <Loader2 className="mr-2 inline h-3.5 w-3.5 animate-spin" />
                    Checking which of these already have a rule…
                  </td>
                </tr>
              ) : null}

              {rows.length === 0 ? (
                <tr className="border-t">
                  <td colSpan={5} className="px-3 py-6 text-center text-sm text-muted-foreground">
                    No unfixed groups are left in this pattern.
                  </td>
                </tr>
              ) : null}

              {unresolved.length > 0 ? (
                <tr className="border-t bg-muted/30">
                  <td colSpan={5} className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide">
                    Still needs an answer ({unresolved.length})
                  </td>
                </tr>
              ) : null}
              {unresolved.map((row) => renderRow(row, true))}

              {/* ALREADY ANSWERED, collapsed and out of the way but never hidden.
                  Removing them would lose the one thing that stops the loop: a
                  group that HAS a rule and came back unfixed anyway is visible
                  here, with the caveat saying the rule may not fit it. */}
              {resolved.length > 0 ? (
                <tr className="border-t bg-muted/30">
                  <td colSpan={5} className="px-3 py-1.5">
                    <button
                      type="button"
                      className="text-xs font-semibold uppercase tracking-wide text-primary"
                      onClick={() => setShowResolved((current) => !current)}
                    >
                      {showResolved ? "▾" : "▸"} Already answered (
                      {resolved.length} group{resolved.length === 1 ? "" : "s"} ·{" "}
                      {resolved
                        .reduce((total, row) => total + row.urls, 0)
                        .toLocaleString("en-US")}{" "}
                      URLs)
                    </button>
                  </td>
                </tr>
              ) : null}
              {showResolved ? resolved.map((row) => renderRow(row, true)) : null}

              {/* LEFT AS THEY ARE — collapsed, and kept out of the selectable
                  rows above rather than deleted from the list. The group is still
                  genuinely unfixed and still counted in the shortfall, so hiding
                  it would make the dialog disagree with the report that sent the
                  operator here. It carries its own undo. */}
              {leftAsIs.length > 0 ? (
                <tr className="border-t bg-muted/30">
                  <td colSpan={5} className="px-3 py-1.5">
                    <button
                      type="button"
                      className="text-xs font-semibold uppercase tracking-wide text-slate-500"
                      onClick={() => setShowLeftAsIs((current) => !current)}
                    >
                      {showLeftAsIs ? "▾" : "▸"} Left as they are (
                      {leftAsIs.length} group{leftAsIs.length === 1 ? "" : "s"} ·{" "}
                      {leftAsIs
                        .reduce((total, row) => total + row.urls, 0)
                        .toLocaleString("en-US")}{" "}
                      URLs)
                    </button>
                  </td>
                </tr>
              ) : null}
              {showLeftAsIs
                ? leftAsIs.map((row) => renderRow(row, false))
                : null}
            </tbody>
          </table>
        </div>

        {editingRow ? (
          <div className="space-y-3 rounded-md border border-primary/40 bg-primary/5 p-3">
            <p className="text-sm font-semibold">
              What should these URLs become?
            </p>
            <p className="text-xs text-muted-foreground">
              Edit each URL below into the one it should redirect to. The same
              change is worked out for every URL in this group — you never write
              a rule yourself.
            </p>
            {editingRow.examples.map((source, index) => (
              <div key={source} className="space-y-1">
                <p className="break-all font-mono text-xs text-muted-foreground">
                  {source}
                </p>
                <input
                  className="w-full rounded border px-2 py-1 font-mono text-xs"
                  value={drafts[index] ?? ""}
                  onChange={(event) =>
                    setDrafts((current) => {
                      const next = [...current];

                      next[index] = event.target.value;

                      return next;
                    })
                  }
                />
              </div>
            ))}
            {error ? (
              <p className="text-xs font-medium text-destructive">{error}</p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setEditing(null)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void save(false)}
                disabled={busy}
              >
                {saving ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : null}
                Save for this group
              </Button>
              {/* The bulk action, and the one the reported case needed: 24
                  groups sharing one prefix and one correct change between them.
                  Only offered when it would do something more than the button
                  beside it. The URL count is on it so a save that reaches
                  hundreds of thousands of URLs says so before it is pressed. */}
              {selectedCount > 1 ? (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void save(true)}
                  disabled={busy}
                >
                  {saving ? (
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  ) : null}
                  Save for all {selectedCount} selected groups (
                  {selectedReach(rows, selected).toLocaleString("en-US")} URLs)
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        <DialogFooter className="items-center sm:justify-between">
          {/* Says what Apply covers — every RESOLVED group — not what is
              ticked. Ticking chooses what an edit is saved for; conflating the
              two is how a button quietly includes groups resolved earlier. */}
          <p className="text-xs text-muted-foreground">
            {blocked ?? describeApplyScope(rows)}
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Close
            </Button>
            <Button
              type="button"
              disabled={blocked !== null || busy}
              onClick={() => void apply()}
            >
              {applying ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : null}
              Fix selected groups
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
