"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";

import { saveShapeRule, type SkippedShape } from "@/lib/api";
import {
  applyBlockedReason,
  buildSkippedGroupRows,
  describeReach,
  describeRule,
  selectedReach,
  type ShapeRuleState
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

type Props = {
  sessionId: string;
  patternId: string;
  template: string;
  shapes: SkippedShape[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Re-run the fix. The dialog does not apply anything itself: saving a rule and
  // applying it are separate acts, and the apply already knows how to pick up
  // every agreed rule for the pattern.
  onApply: () => void;
};

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

export function UnfixedGroupsDialog({
  sessionId,
  patternId,
  template,
  shapes,
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
  }, [open, patternId]);

  const rows = useMemo(
    () => buildSkippedGroupRows(shapes, rules),
    [shapes, rules]
  );
  const blocked = applyBlockedReason(rows, selected);
  const reach = selectedReach(rows, selected);
  const editingRow = rows.find((row) => row.shape === editing) ?? null;

  function openEditor(shape: string, examples: string[]) {
    setEditing(shape);
    // Seeded with the URLs as they are now, so the operator EDITS rather than
    // types. An empty box would be a blank-page problem on a task whose answer
    // is a small change to something already on screen.
    setDrafts([...examples]);
    setError("");
  }

  async function save() {
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
      const result = await saveShapeRule(sessionId, patternId, {
        shape: editingRow.shape,
        pairs
      });

      setRules((current) => {
        const next = new Map(current);

        next.set(editingRow.shape, {
          kind: "operator",
          summary: describeRule(result.rule)
        });

        return next;
      });
      // Saving is consent to include it — anything else means ticking the row a
      // second time to say what you just said.
      setSelected((current) => new Set(current).add(editingRow.shape));
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Unfixed URL groups</DialogTitle>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          These URLs are in{" "}
          <code className="font-mono text-xs">{template}</code> but the fix left
          them alone, because nothing yet says where they should go. Set the
          result for a group, then run the fix again.
        </p>

        <div className="max-h-[420px] overflow-y-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted/60 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="w-8 px-3 py-2" />
                <th className="px-3 py-2">Example URL</th>
                <th className="px-3 py-2">Affects</th>
                <th className="px-3 py-2">What will happen</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.shape} className="border-t align-top">
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label={`Select ${row.shape}`}
                      className="mt-1 h-4 w-4 rounded border-slate-300"
                      checked={selected.has(row.shape)}
                      onChange={() =>
                        setSelected((current) => {
                          const next = new Set(current);

                          if (next.has(row.shape)) {
                            next.delete(row.shape);
                          } else {
                            next.add(row.shape);
                          }

                          return next;
                        })
                      }
                    />
                  </td>
                  <td className="max-w-[280px] px-3 py-2" title={row.shape}>
                    <span className="block break-all font-mono text-xs">
                      {row.examples[0] ?? row.shape}
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
                    ) : (
                      <span className="space-y-0.5">
                        <span className="block font-mono text-xs">
                          {row.rule.summary}
                        </span>
                        <span className="block text-[11px] uppercase tracking-wide text-muted-foreground">
                          {row.rule.kind === "operator"
                            ? "You set this"
                            : "Measured"}
                        </span>
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    <button
                      type="button"
                      className="text-xs font-semibold text-primary underline hover:text-primary/80"
                      onClick={() => openEditor(row.shape, row.examples)}
                    >
                      {row.rule.kind === "none" ? "Set the result" : "Edit"}
                    </button>
                  </td>
                </tr>
              ))}
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
                disabled={saving}
              >
                Cancel
              </Button>
              <Button type="button" size="sm" onClick={save} disabled={saving}>
                {saving ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : null}
                Save for this group
              </Button>
            </div>
          </div>
        ) : null}

        <DialogFooter className="items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {blocked ??
              `Ready to fix ${formatNumber(reach)} URL${
                reach === 1 ? "" : "s"
              } in ${selected.size} group${selected.size === 1 ? "" : "s"}.`}
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Close
            </Button>
            <Button
              type="button"
              disabled={blocked !== null}
              onClick={() => {
                onOpenChange(false);
                onApply();
              }}
            >
              Fix selected groups
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
