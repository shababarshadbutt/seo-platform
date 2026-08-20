"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Gauge,
  FileText,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Trash2
} from "lucide-react";

import {
  deleteVerifiedUrls,
  getDeleteProblemUrlsStatus,
  getPatternRecheck,
  getPatternTriage,
  getStatusFileBreakdown,
  getVerificationStatus,
  startPatternRecheck,
  startPatternTriage,
  startUrlVerification,
  type PatternRecheckStatus,
  type RefusedHost,
  type StatusFileBreakdown,
  type StructureFilter,
  type TriageRun,
  type VerificationStatus
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { etaSecondsFrom, verifyProgress } from "@/lib/verify-progress";
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
  // The status-chip selection, OWNED BY THE PARENT (v1.52).
  //
  // It used to be local state here, which made the chips look like a filter
  // while filtering nothing: the URL list they sit above lives in the parent,
  // so selecting 404 changed the delete target and the chip styling but left
  // the list showing every status. Lifting it is what connects the two.
  // Empty = all problem statuses.
  selectedStatuses: Set<number>;
  onSelectedStatusesChange: (next: Set<number>) => void;
  // Called when a pattern re-check finishes, so the parent can refresh the
  // results table underneath — the row's Status / Confidence / Redirect cells are
  // exactly what a re-check rewrites. Must be stable (useCallback): it is a
  // dependency of the poll loop.
  onRescored?: () => void;
  // Start the re-check immediately on open, without a second click.
  //
  // Set when the dialog was opened from the table's "Check" button, which appears
  // only on never-scored rows: pressing something labelled Check and having it
  // merely open a panel is what made that button a dead end. The amber "Fix" path
  // leaves this false — that row already has a measurement, so re-probing it stays
  // an explicit choice.
  autoStartRecheck?: boolean;
  // The host verdict for this session, when its edge refused every request profile.
  //
  // Without it this panel would tell a skipped pattern "none of its URLs were sampled
  // during analysis", which is technically true and actively misleading: they were not
  // sampled because the site refused us, not because anybody forgot. A skipped pattern
  // and a never-attempted one look identical in the data, so the reason has to be
  // passed in.
  hostRefused?: RefusedHost | null;
  // "Limit this edit to" from the Fix modal above (v1.66). Every action this
  // panel starts narrows to the chosen structure(s): verification probes only
  // that structure's URLs, and the delete removes only its verified rows. Passed
  // in rather than owned here because the dropdowns live in the parent dialog,
  // where they also scope the URL list and the Accept button.
  //
  // Empty/absent = the whole pattern, exactly the pre-v1.66 behaviour.
  structureFilters?: StructureFilter[] | null;
};

// Below this a full verification is already quick enough that offering a second,
// weaker option only adds a decision. At ~50 req/s a 20,000-URL pattern is
// roughly 7 minutes; past that the hours start.
const STRATIFIED_WORTH_IT = 20000;

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

// "about 4 minutes", "about 1 hour 20 minutes". Deliberately coarse: the rate
// drifts with the mix of statuses still to come, so minute-level precision on a
// 40-minute estimate would be false confidence.
function formatEta(seconds: number) {
  if (seconds < 60) {
    return "under a minute";
  }

  const minutes = Math.round(seconds / 60);

  if (minutes < 60) {
    return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;

  return `about ${hours} hour${hours === 1 ? "" : "s"}${
    rest > 0 ? ` ${rest} minute${rest === 1 ? "" : "s"}` : ""
  }`;
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
  onDeleted,
  selectedStatuses,
  onSelectedStatusesChange,
  onRescored,
  autoStartRecheck = false,
  hostRefused = null,
  structureFilters = null
}: Props) {
  const [verification, setVerification] = useState<VerificationStatus | null>(
    null
  );
  const [triage, setTriage] = useState<TriageRun | null>(null);
  const [recheck, setRecheck] = useState<PatternRecheckStatus | null>(null);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  // The per-file breakdown of what a delete is about to remove, shown as a
  // confirmation step BEFORE anything is deleted.
  //
  // Deleting used to be one press against a bare total ("Delete 2,300 URLs"),
  // which is enough to authorise the action and not enough to review it: a
  // reviewer cannot tell from a total whether the URLs are spread thinly across
  // the whole set or concentrated in one file that is itself the problem. null =
  // no review open.
  const [deleteReview, setDeleteReview] = useState<StatusFileBreakdown | null>(
    null
  );
  const [reviewLoading, setReviewLoading] = useState(false);
  const [showStrata, setShowStrata] = useState(false);
  // True between the POST and the first poll that sees the job — without it the
  // button appears to do nothing for up to POLL_MS.
  const [recheckStarting, setRecheckStarting] = useState(false);
  // Was the re-check running on the previous poll? The falling edge is what tells
  // the parent to reload the results table, since the row's cells only change when
  // the job commits.
  const recheckWasRunning = useRef(false);
  // Guards the initial load so a slow first fetch cannot overwrite state from a
  // Verify the user started in the meantime.
  const loadedForPattern = useRef<string | null>(null);
  // One auto-start per pattern, ever. Without this the effect below would re-fire
  // on every poll result and hammer the endpoint.
  const autoStartedForPattern = useRef<string | null>(null);
  // First (time, done) seen for the current job AND PHASE, which is what turns
  // progress into a time estimate. Keyed per "<jobId>:<phase>" so re-opening the
  // modal on a run already in flight starts a fresh measurement instead of
  // dividing by the whole elapsed time of a run it did not watch — and so
  // crossing from the file scan to probing re-measures rather than predicting URL
  // throughput from a file rate. (v1.69.1)
  const progressAnchor = useRef<{
    key: string;
    at: number;
    done: number;
  } | null>(null);
  const [etaSeconds, setEtaSeconds] = useState<number | null>(null);

  // Empty selection means "every problem status" — same convention as the
  // Delete Problem URLs dialog, so the two read the same way.
  const selected = selectedStatuses;
  const setSelected = onSelectedStatusesChange;
  const effectiveStatuses = useMemo(
    () =>
      selected.size > 0
        ? PROBLEM_STATUSES.filter((code) => selected.has(code))
        : PROBLEM_STATUSES,
    [selected]
  );

  const verifyJob = verification?.job ?? null;
  const verifyRunning = Boolean(verifyJob && IN_FLIGHT.includes(verifyJob.status));

  // ---- phase 1: enumerating the population (v1.53) --------------------------
  // urls_total is 0 for the whole enumeration phase because discovering the URL
  // total IS that phase's job. It used to be the only signal, so the panel could
  // draw nothing but an indeterminate spinner — for 10+ minutes on a 10.8M-URL
  // pattern. enum_files_* carry real per-file progress through it.
  //
  // Both conditions are required: urls_total === 0 identifies the phase, and a
  // non-null enum_files_total means the backend has published the denominator.
  // In the brief window before it does, this stays false and the plain spinner
  // shows — better than a bogus "0 of 0".
  const enumFilesTotal = verifyJob?.enum_files_total ?? null;
  const enumFilesDone = verifyJob?.enum_files_done ?? 0;
  const isEnumerating =
    (verifyJob?.urls_total ?? 0) === 0 &&
    enumFilesTotal !== null &&
    enumFilesTotal > 0;
  // QUEUED, not working (v1.69.1). The verification queue is concurrency 1, so a
  // second request waits. This state had no rendering at all, which is why a
  // queued "Check by shape" looked identical to a hung one for 15 minutes.
  const isQueued = verifyJob?.status === "PENDING" && !isEnumerating;
  const blockedBy = verification?.blocked_by ?? null;
  // Whether the bar has anything to divide by. False in the window before either
  // phase has published a total — the job is still queued, or the file list query
  // has not returned — which is exactly when a determinate bar would sit at 0%
  // and read as a stall.
  const hasProgressDenominator =
    isEnumerating || (verifyJob?.urls_total ?? 0) > 0;
  const triageRunning = Boolean(triage && IN_FLIGHT.includes(triage.status));
  // "Pending" covers the queue gap: the POST has returned but the job has not yet
  // shown up as waiting/active, and the poll loop must not stop in that window.
  const recheckPending = Boolean(recheck?.running) || recheckStarting;
  // Never scored, and not because nobody looked: every stored sample was refused
  // by the site's WAF. patternScore treats a blocked sample as the ABSENCE of a
  // measurement, so this renders as "Not scored" — identical to never-checked —
  // and this is the only place the difference can be stated.
  const allSamplesBlocked = Boolean(
    recheck &&
      recheck.sample_total > 0 &&
      recheck.blocked_count === recheck.sample_total
  );
  const neverSampled = Boolean(recheck && recheck.sample_total === 0);

  const refresh = useCallback(async () => {
    // All three scoped to this pattern: the status call carries pattern_id, and
    // the triage and re-check endpoints are per-pattern by construction.
    const [nextVerification, nextTriage, nextRecheck] = await Promise.all([
      getVerificationStatus(sessionId, patternId),
      getPatternTriage(sessionId, patternId),
      getPatternRecheck(sessionId, patternId)
    ]);

    setVerification(nextVerification);
    setTriage(nextTriage.run);
    setRecheck(nextRecheck);

    // The job we were waiting on is done: the row's Status / Confidence /
    // Redirect have been rewritten, so the table underneath is now stale.
    //
    // The flag is armed by handleRecheck rather than by the first poll that sees
    // `running`, because a single-URL pattern can finish inside one poll interval
    // — waiting to observe the running state would miss exactly the rows this
    // feature exists for.
    if (nextRecheck.running) {
      // Armed by observation too, so a re-check started in another tab (or before
      // this modal was opened) still refreshes the table when it lands.
      recheckWasRunning.current = true;
    } else if (recheckWasRunning.current) {
      recheckWasRunning.current = false;
      setRecheckStarting(false);
      onRescored?.();
    }

    // Time remaining, from the rate this run is ACTUALLY achieving rather than
    // from the configured ceiling. The two differ: one URL check costs one or
    // two HTTP requests depending on what the URL returns, so a redirect-heavy
    // pattern moves at roughly half the checks/second of a 404-heavy one under
    // the same request budget. Measuring beats predicting.
    const job = nextVerification.job;

    // ONE anchor, EITHER phase (v1.69.1). It used to key on urls_total > 0, so an
    // ETA existed only while probing — which is why a run sitting in the file scan
    // showed no timeline at all, and a queued one showed nothing whatsoever.
    //
    // The phase choice and the reset key live in lib/verify-progress.ts: this
    // component has no test harness, and those are the parts with real reasoning.
    const progress = verifyProgress(job);

    if (job && IN_FLIGHT.includes(job.status) && progress.anchorKey !== null) {
      const now = Date.now();
      const anchor = progressAnchor.current;

      if (!anchor || anchor.key !== progress.anchorKey) {
        progressAnchor.current = {
          key: progress.anchorKey,
          at: now,
          done: progress.done
        };
        setEtaSeconds(null);
      } else {
        const eta = etaSecondsFrom({
          elapsedSeconds: (now - anchor.at) / 1000,
          completed: progress.done - anchor.done,
          remaining: progress.total - progress.done
        });

        if (eta !== null) {
          setEtaSeconds(eta);
        }
      }
    } else {
      progressAnchor.current = null;
      setEtaSeconds(null);
    }

    return {
      verification: nextVerification,
      triage: nextTriage.run,
      recheck: nextRecheck
    };
  }, [sessionId, patternId, onRescored]);

  useEffect(() => {
    if (loadedForPattern.current === patternId) {
      return;
    }

    loadedForPattern.current = patternId;
    setVerification(null);
    setTriage(null);
    setRecheck(null);
    setRecheckStarting(false);
    recheckWasRunning.current = false;
    setError("");
    setShowStrata(false);

    void refresh().catch(() => {
      // Non-fatal: the rest of the modal (the rule-based fix list) still works.
    });
  }, [patternId, refresh]);

  // Opened from the table's Check button: do the check.
  //
  // Deliberately AFTER the first status load rather than on mount, so a pattern with
  // no stored sample pool never fires a request that can only 400 — the panel says
  // so instead. Also skipped when a run is already in flight (a reopened modal, a
  // second tab), which the endpoint would attach to anyway.
  useEffect(() => {
    if (
      !autoStartRecheck ||
      !recheck ||
      recheck.running ||
      recheck.pool_total === 0 ||
      autoStartedForPattern.current === patternId
    ) {
      return;
    }

    autoStartedForPattern.current = patternId;
    void handleRecheck();
    // handleRecheck is re-created every render and is not a meaningful dependency;
    // the ref above is what makes this fire exactly once per pattern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStartRecheck, recheck, patternId]);

  // One poll loop for all three jobs — they can legitimately run at the same time
  // (different queues), and polling them together keeps the displays from
  // disagreeing about which phase the pattern is in.
  useEffect(() => {
    if (!verifyRunning && !triageRunning && !recheckPending) {
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
          (next.triage && IN_FLIGHT.includes(next.triage.status)) ||
          next.recheck.running ||
          // Keep polling across the gap between the POST and the job becoming
          // visible in the queue, or the loop would stop before it ever started.
          recheckStarting;

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
  }, [verifyRunning, triageRunning, recheckPending, recheckStarting, refresh]);

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

  // Re-measure the pattern's sample and rescore the row. This is the ONLY action
  // in this panel that can change the table's Status / Confidence / Redirect cells
  // — triage and verification write their own tables and always left an unscored
  // row unscored, however many times it was pressed.
  async function handleRecheck() {
    setError("");
    setRecheckStarting(true);
    // Armed before the request so a re-check that finishes inside one poll
    // interval still triggers the parent's refresh.
    recheckWasRunning.current = true;

    try {
      await startPatternRecheck(sessionId, patternId);
      await refresh();
    } catch (nextError) {
      setRecheckStarting(false);
      recheckWasRunning.current = false;
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Unable to start the re-check."
      );
    }
  }

  // strategy "stratified" probes ~50 per URL SHAPE instead of every URL (v1.69).
  // On the reported 579,034-URL pattern that is roughly 1,150 requests rather
  // than 579,034 — minutes instead of 3h17m — because URLs sharing a shape come
  // from one CMS template. Shapes whose samples DISAGREE are reported unagreed
  // rather than extrapolated, so nothing is guessed about a shape that is not
  // actually uniform.
  async function handleVerify(strategy: "full" | "stratified" = "full") {
    setError("");

    try {
      // The pattern id is the whole fix. Without it this verifies the session.
      await startUrlVerification(
        sessionId,
        [patternId],
        selected.size > 0 ? effectiveStatuses : undefined,
        structureFilters,
        strategy
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

  // Step one of deleting: fetch what is about to be removed and show it. Nothing
  // is deleted here — handleDelete below is only reachable from the review.
  async function openDeleteReview() {
    if (reviewLoading || deleting) {
      return;
    }

    setReviewLoading(true);
    setError("");

    try {
      setDeleteReview(
        await getStatusFileBreakdown(sessionId, patternId, effectiveStatuses)
      );
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Unable to list the files these URLs are in."
      );
    } finally {
      setReviewLoading(false);
    }
  }

  async function handleDelete() {
    if (deleting) {
      return;
    }

    setDeleting(true);
    setError("");

    try {
      await deleteVerifiedUrls(
        sessionId,
        patternId,
        effectiveStatuses,
        structureFilters
      );

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
    const next = new Set(selected);

    if (next.has(code)) {
      next.delete(code);
    } else {
      next.add(code);
    }

    setSelected(next);
    // The chips ARE the delete target, so an open review no longer describes
    // what the button would do. Closing it is the only safe option: leaving a
    // stale file list next to a changed target is how someone confirms a delete
    // against numbers they were shown for a different status.
    setDeleteReview(null);
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

      {/* ---- the SAMPLED layer -------------------------------------------
          Speaks for the pattern ROW itself (Status / Confidence / Redirect),
          which nothing else in this panel can change: triage and verification
          write their own tables. It is also the only place "we checked and the
          site refused to answer" can be told apart from "nobody has checked" —
          a blocked sample is the absence of a measurement, so both render as
          "Not scored" in the table. */}
      {recheckPending ? (
        <div className="flex items-center gap-2 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-900">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
          Re-checking this pattern&rsquo;s sampled URLs and rescoring the row…
        </div>
      ) : allSamplesBlocked ? (
        <p
          className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          data-testid="sample-blocked-note"
        >
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            The site refused all {formatNumber(recheck?.sample_total ?? 0)}{" "}
            sampled URL
            {(recheck?.sample_total ?? 0) === 1 ? "" : "s"} — bot protection
            answered instead of the page
            {(recheck?.used_fallback_count ?? 0) > 0
              ? ", on a browser profile as well as the crawler one"
              : ""}
            . This row reads &ldquo;Not scored&rdquo; because a blocked response
            measures nothing, not because the URLs are broken.
          </span>
        </p>
      ) : hostRefused ? (
        <p
          className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          data-testid="sample-host-refused-note"
        >
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Skipped — {hostRefused.host}&rsquo;s edge refused every request
            profile
            {hostRefused.edge_server ? ` (${hostRefused.edge_server})` : ""}, so
            this pattern was not probed at all. Nothing is wrong with these URLs
            as far as we know; the checker needs to be allowlisted at that edge
            first.
          </span>
        </p>
      ) : neverSampled ? (
        <p
          className="flex items-start gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600"
          data-testid="sample-missing-note"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            None of this pattern&rsquo;s URLs were sampled during analysis, so it
            has no score. Re-check to sample and score it now.
          </span>
        </p>
      ) : null}

      {/* ---- banner: what is sampled vs estimated vs verified ------------- */}
      {verifyRunning ? (
        <div
          className="space-y-2 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2"
          data-testid="verify-progress"
        >
          <p className="flex items-center gap-2 text-sm text-indigo-900">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
            {isQueued ? (
              <span data-testid="verify-queued">
                Waiting to start — another verification is running on this
                session
                {blockedBy && Number(blockedBy.urls_total ?? 0) > 0
                  ? ` (${formatNumber(
                      Number(blockedBy.urls_done ?? 0)
                    )} of ${formatNumber(
                      Number(blockedBy.urls_total ?? 0)
                    )} URLs)`
                  : ""}
                . This one keeps its place in the queue — you can close this and
                come back.
              </span>
            ) : isEnumerating ? (
              <span data-testid="verify-enum-progress">
                Scanning sitemap files: {formatNumber(enumFilesDone)} of{" "}
                {formatNumber(enumFilesTotal ?? 0)}…
              </span>
            ) : (verifyJob?.urls_total ?? 0) === 0 ? (
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
          {/* One bar, THREE states. It used to sit at 0 for the entire
              enumeration because its only input was the URL counter, which is 0
              until enumeration finishes; phase 1 now drives it off files and
              phase 2 off URLs.

              The third state is the one reported from a live 1.3M-URL run: the
              window before ANY denominator is known — the job is queued, or the
              file list query has not returned — where both phases have nothing
              to divide by. That rendered as a determinate bar at 0%, which is
              indistinguishable from a run that has hung. A determinate bar makes
              a claim about progress; with no denominator there is no claim to
              make, so it animates instead of asserting zero. */}
          {hasProgressDenominator ? (
            <Progress
              value={
                isEnumerating
                  ? Math.round((enumFilesDone / (enumFilesTotal ?? 1)) * 100)
                  : Math.round(
                      ((verifyJob?.urls_done ?? 0) /
                        (verifyJob?.urls_total ?? 1)) *
                        100
                    )
              }
            />
          ) : (
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-indigo-100"
              role="progressbar"
              aria-label="Starting verification"
              data-testid="verify-progress-indeterminate"
            >
              <div className="h-full w-1/3 animate-pulse rounded-full bg-indigo-500" />
            </div>
          )}
          {/* Why the bar can open near the end. urls_done STARTS at the number
              of URLs this run does not have to probe, so a re-verify of an
              unedited pattern jumps straight to ~95% — correct, but it reads as
              skipped work unless the reuse is named. */}
          {(verifyJob?.urls_reused ?? 0) > 0 ? (
            <p
              className="text-xs text-indigo-800/80"
              data-testid="verify-reused-note"
            >
              {formatNumber(verifyJob?.urls_reused ?? 0)} URL
              {(verifyJob?.urls_reused ?? 0) === 1 ? "" : "s"} reused from the
              last check — unchanged files, recent enough to still be true. Only
              the rest are being re-probed.
            </p>
          ) : null}
          <p className="text-xs text-indigo-800/80">
            {etaSeconds !== null ? (
              <>
                <span className="font-semibold">
                  {formatEta(etaSeconds)} remaining
                </span>{" "}
                ·{" "}
              </>
            ) : null}
            {/* Phase-accurate (v1.69.1). "Rate-limited" is only true of the
                HTTP phase — saying it while the job is queued or reading files
                off disk explains the wrong thing, and during a queue wait it
                actively misdirects: the run is not slow, it has not started. */}
            {isQueued
              ? "Nothing is being checked yet — the queue runs one verification at a time so a big sweep cannot be starved by a small one."
              : isEnumerating
                ? "Reading the sitemap files to find this pattern's URLs. Disk-bound, not rate-limited — the HTTP checks start after this."
                : "Deliberately rate-limited so the check cannot overload the site being crawled — this is the speed, not a stall."}
          </p>
          {/* Background verification already worked: the job runs server-side
              and re-attaches on reopen. It was simply never said, so a user
              watching a 40-minute bar had no reason to think they could leave. */}
          <p className="text-xs text-indigo-800/80">
            You can close this and keep working — it keeps running, and
            reopening this pattern shows the progress again.
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
            {/* The action that rewrites the ROW. Listed first for an unscored
                pattern, because for that row it is the only one that changes what
                the table says. */}
            <Button
              type="button"
              size="sm"
              variant={allSamplesBlocked || neverSampled ? "default" : "outline"}
              className="gap-1"
              disabled={recheckPending || recheck?.pool_total === 0}
              onClick={() => void handleRecheck()}
              data-testid="pattern-recheck"
            >
              {recheckPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              {recheckPending
                ? "Re-checking…"
                : `Re-check ${
                    recheck && recheck.sample_total > 0
                      ? `${formatNumber(recheck.sample_total)} sampled URL${
                          recheck.sample_total === 1 ? "" : "s"
                        }`
                      : "this pattern’s sample"
                  }`}
            </Button>
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
            {/* Offered ABOVE the full run and only where it would actually save
                something: on a small pattern the full check is already quick and
                a second button is just a choice nobody needs to make. The
                threshold is the point past which sampling beats probing
                everything by enough to matter. */}
            {populationTotal >= STRATIFIED_WORTH_IT ? (
              <Button
                type="button"
                size="sm"
                variant="default"
                onClick={() => void handleVerify("stratified")}
                title="Probes about 50 URLs per URL shape and infers the rest from each shape's own rule. Shapes whose samples disagree are reported, not guessed."
              >
                Check by shape — {formatNumber(populationTotal)} URLs in minutes
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant={
                isConfirmed || allSamplesBlocked || neverSampled
                  ? "outline"
                  : "default"
              }
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
            disabled={confirmedTarget === 0 || deleting || reviewLoading}
            // Opens the review rather than deleting. The second press, inside
            // the review, is the one that acts.
            onClick={() => void openDeleteReview()}
          >
            {reviewLoading ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Checking which files…
              </>
            ) : (
              <>
                <Trash2 className="h-3.5 w-3.5" />
                Review &amp; delete {formatNumber(confirmedTarget)} confirmed{" "}
                {statusLabel(effectiveStatuses)} URL
                {confirmedTarget === 1 ? "" : "s"}
              </>
            )}
          </Button>
        ) : null}
      </div>

      {/* ---- delete review: the file-by-file breakdown ---------------------
          Named files with counts, because "Delete 2,300 URLs" is a number a
          reviewer can approve but cannot check. Biggest first: the file at the
          top is usually the finding, not just the largest total. */}
      {deleteReview ? (
        <div
          className="space-y-3 rounded-md border border-red-200 bg-red-50 px-3 py-3"
          data-testid="delete-file-breakdown"
        >
          <p className="text-sm font-semibold text-red-900">
            About to remove {formatNumber(deleteReview.total_urls)}{" "}
            {statusLabel(deleteReview.statuses)} URL
            {deleteReview.total_urls === 1 ? "" : "s"} from{" "}
            {formatNumber(deleteReview.files.length)} file
            {deleteReview.files.length === 1 ? "" : "s"}
          </p>

          {deleteReview.files.length === 0 ? (
            // Zero files AND zero URLs means nothing has been verified for these
            // statuses — which is a different thing from "nothing to delete", and
            // must not be reported as a clean result.
            <p className="text-sm text-red-900">
              Nothing verified for {statusLabel(deleteReview.statuses)} in this
              pattern yet, so there is nothing to delete. Run Verify above first.
            </p>
          ) : (
            <>
              <ul className="max-h-48 space-y-1 overflow-y-auto" role="list">
                {deleteReview.files.map((file) => (
                  <li
                    key={file.source_file}
                    className="flex items-center justify-between gap-3 rounded bg-white/70 px-2 py-1 text-xs"
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <FileText
                        className="h-3.5 w-3.5 shrink-0 text-red-500"
                        aria-hidden="true"
                      />
                      <span
                        className="truncate font-mono text-slate-700"
                        title={file.source_file}
                      >
                        {file.source_file}
                      </span>
                    </span>
                    <span className="shrink-0 font-semibold text-red-800">
                      {formatNumber(file.urls)} URL
                      {file.urls === 1 ? "" : "s"}
                    </span>
                  </li>
                ))}
              </ul>

              {/* What survives matters as much as what goes. Answering it here
                  stops it being guessed at over an irreversible action. */}
              <p className="text-xs text-red-900/80">
                Only these <code>&lt;loc&gt;</code> entries are removed — the
                files themselves are kept and rewritten, and every other URL in
                them is untouched. A file left with no URLs at all is dropped as
                an empty sitemap.
                {deleteReview.total_urls !==
                deleteReview.files.reduce((sum, file) => sum + file.urls, 0) ? (
                  <>
                    {" "}
                    The per-file counts add up to more than the total because a
                    URL listed in several files is counted in each.
                  </>
                ) : null}
              </p>

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  className="gap-1"
                  disabled={deleting}
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
                      Delete from {formatNumber(deleteReview.files.length)} file
                      {deleteReview.files.length === 1 ? "" : "s"}
                    </>
                  )}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={deleting}
                  onClick={() => setDeleteReview(null)}
                >
                  Cancel
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {/* Deletion is gated on a full verification, always. An estimate can be
          out by hundreds of URLs, and deleting a live page is not undoable from
          the client's side even though it is from ours. */}
      {!isConfirmed && !verifyRunning ? (
        <p className="text-xs text-slate-500">
          Deleting requires a completed verification — estimates are never
          deleted from.
        </p>
      ) : null}
      {/* Says which action affects which surface. Re-check is the only one that
          rewrites the row in the table; the other two answer questions about the
          population and store their answers separately. */}
      <p className="text-xs text-slate-500">
        Re-check re-probes the handful of URLs this pattern was scored on and
        updates its Status, Confidence and Redirect columns
        {recheck?.last_checked_at
          ? ` (last checked ${new Date(recheck.last_checked_at).toLocaleString()})`
          : ""}
        . Quick check and Verify answer questions about the whole population and
        do not change those columns.
      </p>

      {error ? <p className="text-xs text-red-500">{error}</p> : null}
      <p className="sr-only">Pattern {template}</p>
    </div>
  );
}
