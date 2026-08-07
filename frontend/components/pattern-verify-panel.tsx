"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Gauge,
  Loader2,
  Trash2
} from "lucide-react";

import {
  deleteVerifiedUrls,
  getDeleteProblemUrlsStatus,
  getPatternTriage,
  getVerificationStatus,
  startPatternTriage,
  startUrlVerification,
  type TriageRun,
  type VerificationStatus
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

// The Fix Redirect URLs modal's verify-and-delete section, scoped to ONE
// pattern (v1.50).
//
// WHAT WAS WRONG. This section used to be a bare progress bar over
// startUrlVerification(sessionId) — no pattern id — so pressing Verify inside
// one pattern's modal HTTP-checked the entire session. Live: a 25,744-URL
// pattern produced "Verifying 167,575 of 1,324,310 URLs…" and ran for 75-90
// minutes. Two defects, one visible and one not: the run was 51x too large, and
// the UI said nothing about what it was verifying, so the number looked like a
// mystery rather than a mistake.
//
// The design now follows the Delete Problem URLs dialog, which had already
// solved the honesty problem for the session-wide case: an explicit banner
// saying what is sampled versus verified, an explicit Verify action rather than
// an implicit background sweep, filter chips per status code, and real counts
// once verified. Everything here says WHICH pattern and WHICH mode produced
// every number.
//
// THREE MODES, and the UI must never blur them:
//   * sampled   — the 5-20 URLs pattern sampling already checked. Indicative.
//   * estimated — a ~1% triage draw, extrapolated. Always prefixed "~" and
//                 always accompanied by the real sample rate.
//   * confirmed — a full scoped verification. Exact, no qualifier, and the ONLY
//                 mode that unlocks deletion.

const PROBLEM_STATUSES = [301, 302, 307, 308, 404];
const IN_FLIGHT = ["PENDING", "RUNNING"];
const POLL_MS = 1500;

type Props = {
  sessionId: string;
  patternId: string;
  template: string;
  // Called after a delete completes so the parent can refresh results and
  // close the modal.
  onDeleted: (message: string) => void;
};

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

// The real sample rate, as a percentage with one decimal — "1.0%", "0.3%".
// Never the nominal 1%: the min/max clamps and adaptive expansion move it, and
// quoting a rate the run did not actually use makes the estimate unauditable.
function formatRate(rate: number) {
  if (rate >= 0.999) {
    return "100%";
  }

  const percent = rate * 100;

  return `${percent < 0.1 ? percent.toFixed(2) : percent.toFixed(1)}%`;
}

function statusLabel(codes: number[]) {
  if (codes.length === 0 || codes.length === PROBLEM_STATUSES.length) {
    return "problem";
  }

  return codes.join("/");
}

export function PatternVerifyPanel({
  sessionId,
  patternId,
  template,
  onDeleted
}: Props) {
  const [verification, setVerification] = useState<VerificationStatus | null>(
    null
  );
  const [triage, setTriage] = useState<TriageRun | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [showStrata, setShowStrata] = useState(false);
  // Guards the initial load so a slow first fetch cannot overwrite state from a
  // Verify the user started in the meantime.
  const loadedForPattern = useRef<string | null>(null);

  // Empty selection means "every problem status" — same convention as the
  // Delete Problem URLs dialog, so the two read the same way.
  const effectiveStatuses = useMemo(
    () =>
      selected.size > 0
        ? PROBLEM_STATUSES.filter((code) => selected.has(code))
        : PROBLEM_STATUSES,
    [selected]
  );

  const verifyJob = verification?.job ?? null;
  const verifyRunning = Boolean(verifyJob && IN_FLIGHT.includes(verifyJob.status));
  const triageRunning = Boolean(triage && IN_FLIGHT.includes(triage.status));

  const refresh = useCallback(async () => {
    // Both scoped to this pattern: the status call carries pattern_id, and the
    // triage endpoint is per-pattern by construction.
    const [nextVerification, nextTriage] = await Promise.all([
      getVerificationStatus(sessionId, patternId),
      getPatternTriage(sessionId, patternId)
    ]);

    setVerification(nextVerification);
    setTriage(nextTriage.run);

    return { verification: nextVerification, triage: nextTriage.run };
  }, [sessionId, patternId]);

  useEffect(() => {
    if (loadedForPattern.current === patternId) {
      return;
    }

    loadedForPattern.current = patternId;
    setVerification(null);
    setTriage(null);
    setSelected(new Set());
    setError("");
    setShowStrata(false);

    void refresh().catch(() => {
      // Non-fatal: the rest of the modal (the rule-based fix list) still works.
    });
  }, [patternId, refresh]);

  // One poll loop for both jobs — they can legitimately run at the same time
  // (different queues), and polling them together keeps the two displays from
  // disagreeing about which phase the pattern is in.
  useEffect(() => {
    if (!verifyRunning && !triageRunning) {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        const next = await refresh();

        if (cancelled) {
          return;
        }

        const stillRunning =
          (next.verification.job &&
            IN_FLIGHT.includes(next.verification.job.status)) ||
          (next.triage && IN_FLIGHT.includes(next.triage.status));

        if (stillRunning) {
          timer = setTimeout(tick, POLL_MS);
        }
      } catch {
        if (!cancelled) {
          timer = setTimeout(tick, POLL_MS);
        }
      }
    };

    timer = setTimeout(tick, POLL_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [verifyRunning, triageRunning, refresh]);

  // Exact per-status counts from the full verification, keyed by status.
  const confirmedCounts = useMemo(() => {
    const counts = new Map<number, number>();

    for (const entry of verification?.counts_by_status ?? []) {
      counts.set(entry.http_status, entry.count);
    }

    return counts;
  }, [verification]);

  const isConfirmed = Boolean(
    verification?.verified_at && !verification.stale && !verifyRunning
  );
  const isStale = Boolean(verification?.verified_at && verification.stale);

  const triageResult = triage?.status === "COMPLETE" ? triage.result : null;
  const triageEstimates = useMemo(() => {
    const estimates = new Map<number, number>();

    for (const entry of triageResult?.estimates ?? []) {
      estimates.set(entry.http_status, entry.estimate);
    }

    return estimates;
  }, [triageResult]);

  // The pattern's population. Known exactly from either layer — both enumerate
  // it the same way — so it is never printed with a "~".
  const populationTotal =
    triage?.population_total ||
    (isConfirmed
      ? Array.from(confirmedCounts.values()).reduce((sum, n) => sum + n, 0)
      : 0) ||
    verifyJob?.urls_total ||
    0;

  const confirmedTarget = effectiveStatuses.reduce(
    (sum, code) => sum + (confirmedCounts.get(code) ?? 0),
    0
  );

  async function handleTriage() {
    setError("");

    try {
      await startPatternTriage(
        sessionId,
        patternId,
        selected.size > 0 ? effectiveStatuses : undefined
      );
      await refresh();
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Unable to start the quick check."
      );
    }
  }

  async function handleVerify() {
    setError("");

    try {
      // The pattern id is the whole fix. Without it this verifies the session.
      await startUrlVerification(
        sessionId,
        [patternId],
        selected.size > 0 ? effectiveStatuses : undefined
      );
      await refresh();
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Unable to start verification."
      );
    }
  }

  async function handleDelete() {
    if (deleting) {
      return;
    }

    setDeleting(true);
    setError("");

    try {
      await deleteVerifiedUrls(sessionId, patternId, effectiveStatuses);

      for (;;) {
        const { job } = await getDeleteProblemUrlsStatus(sessionId);

        if (!job || !["PENDING", "RUNNING", "UNDOING"].includes(job.status)) {
          if (job?.status === "FAILED") {
            throw new Error(job.error ?? "The deletion failed.");
          }

          onDeleted(
            `Deleted ${formatNumber(
              Number(job?.items_changed ?? 0)
            )} verified URLs (${effectiveStatuses.join(", ")}) from this pattern's files.`
          );
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Unable to delete verified URLs."
      );
    } finally {
      setDeleting(false);
    }
  }

  function toggleStatus(code: number) {
    setSelected((current) => {
      const next = new Set(current);

      if (next.has(code)) {
        next.delete(code);
      } else {
        next.add(code);
      }

      return next;
    });
  }

  // Chip text carries the MODE in the number itself: a bare count is confirmed,
  // a "~" count is an estimate, and no number at all means unchecked. This is
  // the single most load-bearing detail in the panel — a user deciding whether
  // to delete 25,744 URLs must be able to tell measurement from extrapolation
  // at a glance.
  function chipCount(code: number) {
    if (isConfirmed) {
      return ` · ${formatNumber(confirmedCounts.get(code) ?? 0)}`;
    }

    if (triageEstimates.has(code)) {
      return ` · ~${formatNumber(triageEstimates.get(code) ?? 0)}`;
    }

    return "";
  }

  const scopeNote =
    populationTotal > 0
      ? `${formatNumber(populationTotal)} URLs in this pattern`
      : "this pattern only";

  return (
    <div
      className="space-y-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2"
      data-testid="fix-verified-section"
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-slate-700">
          Check and delete by status code
        </p>
        {/* Says the scope out loud. The original bug was invisible precisely
            because nothing on screen claimed a scope. */}
        <span className="shrink-0 text-xs text-slate-500">{scopeNote}</span>
      </div>

      {/* ---- banner: what is sampled vs estimated vs verified ------------- */}
      {verifyRunning ? (
        <div
          className="space-y-2 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2"
          data-testid="verify-progress"
        >
          <p className="flex items-center gap-2 text-sm text-indigo-900">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
            {(verifyJob?.urls_total ?? 0) === 0 ? (
              <>Finding this pattern&rsquo;s URLs in the sitemap files…</>
            ) : verifyJob?.pattern_ids === null ? (
              // A whole-session run covers this pattern, so it is reported —
              // but labelled, because its counter is the session's, not this
              // pattern's. An unlabelled session-wide number next to one
              // pattern's name is exactly what made the original bug look like
              // a mystery instead of a mistake.
              <>
                A whole-session verification is running (
                {formatNumber(verifyJob.urls_done)} of{" "}
                {formatNumber(verifyJob.urls_total)} URLs across every pattern)
                — it covers this one too.
              </>
            ) : (
              <>
                Verifying {formatNumber(verifyJob?.urls_done ?? 0)} of{" "}
                {formatNumber(verifyJob?.urls_total ?? 0)} URLs in this pattern…
              </>
            )}
          </p>
          <Progress
            value={
              (verifyJob?.urls_total ?? 0) > 0
                ? Math.round(
                    ((verifyJob?.urls_done ?? 0) / (verifyJob?.urls_total ?? 1)) *
                      100
                  )
                : 0
            }
          />
          <p className="text-xs text-indigo-800/80">
            Rate-limited so the check cannot overload the site being crawled.
          </p>
        </div>
      ) : triageRunning ? (
        <div className="flex items-center gap-2 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-900">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
          Quick check running — sampling about 1% of this pattern…
        </div>
      ) : isConfirmed ? (
        <p className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            All {formatNumber(populationTotal)} URLs in this pattern have been
            HTTP-verified. The counts below are exact.
          </span>
        </p>
      ) : isStale ? (
        <p className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Files changed since this pattern was verified — re-verify before
            deleting, or the counts will not match what is in the files.
          </span>
        </p>
      ) : triageResult ? (
        <div className="space-y-1.5 rounded-md border border-sky-200 bg-sky-50 px-3 py-2">
          <p className="flex items-start gap-2 text-sm text-sky-900">
            <Gauge className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {(() => {
                const asked = triageResult.target_statuses;
                const hits = triageResult.estimates.filter(
                  (estimate) => estimate.observed > 0
                );

                if (hits.length === 0) {
                  return (
                    <>
                      No sign of {statusLabel(asked)} URLs — zero found in a
                      sample of {formatNumber(triage?.sampled_total ?? 0)} URLs (
                      {formatRate(triageResult.sample_rate)} of{" "}
                      {formatNumber(populationTotal)}).{" "}
                      <strong className="font-semibold">
                        This is sample-based, not a guarantee
                      </strong>{" "}
                      — a full verification is the only way to be certain.
                    </>
                  );
                }

                return (
                  <>
                    {hits
                      .map(
                        (estimate) =>
                          `~${formatNumber(estimate.estimate)} of ${formatNumber(
                            populationTotal
                          )} URLs estimated as ${estimate.http_status}`
                      )
                      .join("; ")}
                    , based on a {formatRate(triageResult.sample_rate)} sample —
                    verify for an exact count.
                  </>
                );
              })()}
            </span>
          </p>
          <p className="text-xs text-sky-800/80">
            Sampled {formatNumber(triage?.sampled_total ?? 0)} URLs in{" "}
            {(triageResult.duration_ms / 1000).toFixed(1)}s
            {triage?.expanded
              ? " (widened automatically where the sample looked unusual)"
              : ""}
            .
          </p>
          {triageResult.strata.length > 1 ? (
            <button
              type="button"
              onClick={() => setShowStrata((current) => !current)}
              className="flex items-center gap-1 text-xs font-medium text-sky-800 hover:text-sky-900"
            >
              {showStrata ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
              {triageResult.strata.length} sub-patterns sampled separately
            </button>
          ) : null}
          {showStrata ? (
            <div className="space-y-1 pt-1">
              {triageResult.strata.map((stratum) => {
                const hits = triageResult.target_statuses.reduce(
                  (sum, code) =>
                    sum + (stratum.hits_by_status[String(code)] ?? 0),
                  0
                );

                return (
                  <div
                    key={stratum.label}
                    className="flex items-center gap-2 text-xs text-sky-900"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono">
                      {stratum.label}
                    </span>
                    <span className="shrink-0 text-sky-800/70">
                      {formatNumber(stratum.population)} URLs ·{" "}
                      {stratum.sampled} sampled · {hits} hit
                      {hits === 1 ? "" : "s"}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Nothing in this pattern has been checked beyond the handful of URLs
            sampled during analysis. Run a quick check for a fast estimate, or
            verify to get exact counts you can delete from.
          </span>
        </p>
      )}

      {/* ---- status filter chips ----------------------------------------- */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs font-medium text-slate-500">Status:</span>
        <button
          type="button"
          onClick={() => setSelected(new Set())}
          className={`rounded-full px-3 py-1 text-xs font-medium ${
            selected.size === 0
              ? "bg-slate-800 text-white"
              : "bg-white text-slate-600 ring-1 ring-slate-200"
          }`}
        >
          All
          {isConfirmed
            ? ` · ${formatNumber(
                PROBLEM_STATUSES.reduce(
                  (sum, code) => sum + (confirmedCounts.get(code) ?? 0),
                  0
                )
              )}`
            : ""}
        </button>
        {PROBLEM_STATUSES.map((code) => (
          <button
            key={code}
            type="button"
            onClick={() => toggleStatus(code)}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              selected.has(code)
                ? "bg-slate-800 text-white"
                : "bg-white text-slate-600 ring-1 ring-slate-200"
            }`}
          >
            {code}
            {chipCount(code)}
          </button>
        ))}
      </div>
      {!isConfirmed && triageEstimates.size > 0 ? (
        <p className="text-xs text-slate-500">
          &ldquo;~&rdquo; counts are estimates from the sample. Verify to replace
          them with exact numbers.
        </p>
      ) : null}

      {/* ---- actions ------------------------------------------------------ */}
      <div className="flex flex-wrap items-center gap-2">
        {!verifyRunning && !triageRunning ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="gap-1"
              onClick={() => void handleTriage()}
            >
              <Gauge className="h-3.5 w-3.5" />
              {selected.size > 0
                ? `Quick ${statusLabel(effectiveStatuses)} check`
                : "Quick check"}{" "}
              (~1% sample)
            </Button>
            <Button
              type="button"
              size="sm"
              variant={isConfirmed ? "outline" : "default"}
              onClick={() => void handleVerify()}
            >
              {isConfirmed || isStale ? "Re-verify" : "Verify"}
              {selected.size > 0 ? ` ${statusLabel(effectiveStatuses)}` : " all"}{" "}
              {populationTotal > 0
                ? `— ${formatNumber(populationTotal)} URLs`
                : "in this pattern"}
            </Button>
          </>
        ) : null}
        {isConfirmed ? (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="gap-1"
            disabled={confirmedTarget === 0 || deleting}
            onClick={() => void handleDelete()}
          >
            {deleting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Deleting…
              </>
            ) : (
              <>
                <Trash2 className="h-3.5 w-3.5" />
                Delete {formatNumber(confirmedTarget)} confirmed{" "}
                {statusLabel(effectiveStatuses)} URL
                {confirmedTarget === 1 ? "" : "s"}
              </>
            )}
          </Button>
        ) : null}
      </div>

      {/* Deletion is gated on a full verification, always. An estimate can be
          out by hundreds of URLs, and deleting a live page is not undoable from
          the client's side even though it is from ours. */}
      {!isConfirmed && !verifyRunning ? (
        <p className="text-xs text-slate-500">
          Deleting requires a completed verification — estimates are never
          deleted from.
        </p>
      ) : null}

      {error ? <p className="text-xs text-red-500">{error}</p> : null}
      <p className="sr-only">Pattern {template}</p>
    </div>
  );
}
