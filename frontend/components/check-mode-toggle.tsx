"use client";

import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  friendlyApiErrorMessage,
  getUrlCheckMode,
  setUrlCheckMode,
  type UrlCheckModeState
} from "@/lib/api";
import type { UrlCheckMode } from "@/lib/staging-origin";

// The global 1.90 / 2.0 switch: which environment URL health checks are sent to.
//
// GLOBAL AND SERVER-SIDE. One person flipping this changes what everyone's checks
// measure, which is why it confirms before switching to 2.0, why the 2.0 state is
// deliberately loud, and why it polls — another tab or another user can move it
// underneath you.
//
// WHY IT IS NOT NEXT TO THE VERSION PILL. That pill shows the deployed image
// version and exists specifically to expose image/compose drift. A user-flippable
// control reading "1.90" sitting beside a pill reading "v1.90" is unreadable in
// exactly the screenshots this feature has to be legible in, so this lives in the
// right-hand action cluster and never says a bare number.

// Another tab, or another user, can move this. 15s is frequent enough that a stale
// label is short-lived and slow enough to be invisible next to the navbar's
// existing 3s session poll.
const POLL_MS = 15_000;

export function CheckModeToggle() {
  const [state, setState] = useState<UrlCheckModeState | null>(null);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const next = await getUrlCheckMode();

      if (!cancelled) {
        setState(next);
      }
    }

    void load();

    const timer = setInterval(() => {
      // The cached promise has to be dropped or the poll re-reads its own answer.
      void import("@/lib/api").then(({ invalidateUrlCheckMode }) => {
        invalidateUrlCheckMode();
        void load();
      });
    }, POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  async function apply(mode: UrlCheckMode) {
    setIsSaving(true);
    setError("");

    // Optimistic, with rollback: the button must respond to a click even though the
    // write is a round trip, but it must not lie about the outcome.
    const previous = state;

    setState((current) => (current ? { ...current, mode } : current));

    try {
      setState(await setUrlCheckMode(mode));
      setIsConfirmOpen(false);
    } catch (caught) {
      setState(previous);
      setError(
        friendlyApiErrorMessage(caught, "Unable to change the check environment.")
      );
    } finally {
      setIsSaving(false);
    }
  }

  // Until the first read lands, and whenever it fails, render nothing rather than a
  // guess. An amber "2.0" that turns out to be wrong is worse than no control.
  if (!state) {
    return null;
  }

  const isStaging = state.mode === "2.0";

  return (
    <>
      <div
        className={`inline-flex items-center gap-1 rounded-md p-0.5 ring-1 ring-inset ${
          isStaging
            ? "bg-amber-500/20 ring-amber-400/60"
            : "bg-slate-800 ring-slate-700"
        }`}
        title={
          isStaging
            ? "URL health checks are being sent to the STAGING site. Sitemap files, downloads and publishing still use production."
            : "URL health checks are being sent to production (original v1.90 behaviour)."
        }
      >
        <span
          className={`hidden pl-1.5 text-[11px] font-medium sm:inline ${
            isStaging ? "text-amber-200" : "text-slate-400"
          }`}
        >
          Checks
        </span>
        <button
          type="button"
          onClick={() => void apply("1.90")}
          disabled={isSaving}
          className={`h-6 rounded px-2 text-[11px] font-semibold transition-colors disabled:opacity-60 ${
            isStaging
              ? "text-amber-200/70 hover:text-amber-100"
              : "bg-slate-700 text-white"
          }`}
        >
          1.90 · prod
        </button>
        <button
          type="button"
          onClick={() => {
            setError("");
            setIsConfirmOpen(true);
          }}
          disabled={isSaving}
          className={`h-6 rounded px-2 text-[11px] font-semibold transition-colors disabled:opacity-60 ${
            isStaging
              ? "bg-amber-400 text-amber-950"
              : "text-slate-400 hover:text-white"
          }`}
        >
          2.0 · staging
        </button>
      </div>

      <Dialog open={isConfirmOpen} onOpenChange={setIsConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle
                className="h-5 w-5 text-amber-500"
                aria-hidden="true"
              />
              Send URL checks to staging?
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-3 text-sm">
                <p>
                  Every URL health check — sampling, verification and re-checks —
                  will be sent to each session&apos;s staging site instead of
                  production.
                </p>
                {/* The blast radius, stated positively. This is the question
                    everyone asks first, and the answer is the reassuring one. */}
                <p>
                  Sitemap files, rewrites, downloads and publishing are
                  unaffected and always use production.
                </p>
                {/* The data loss. Results are one row per URL, overwritten, so a
                    re-check genuinely replaces the production verdicts. Saying so
                    here is the difference between a considered choice and a
                    surprise. */}
                <p className="font-medium text-amber-700">
                  Re-checking a session will replace its stored production
                  results.
                </p>
                <p>
                  This is a <strong>global</strong> setting — it changes what
                  everyone&apos;s checks measure, not just yours.
                </p>
                {state.running_checks > 0 ? (
                  <p>
                    {state.running_checks} check
                    {state.running_checks === 1 ? " is" : "s are"} currently
                    running. They will finish in 1.90 — the change applies to
                    checks started from now on.
                  </p>
                ) : null}
                {error ? <p className="text-red-500">{error}</p> : null}
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsConfirmOpen(false)}
              disabled={isSaving}
            >
              Cancel
            </Button>
            <Button onClick={() => void apply("2.0")} disabled={isSaving}>
              {isSaving ? "Switching…" : "Switch to 2.0 · staging"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
