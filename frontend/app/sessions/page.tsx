"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  CalendarDays,
  Loader2,
  Plus,
  RefreshCw,
  Trash2
} from "lucide-react";

import {
  deleteSession,
  friendlyApiErrorMessage,
  getSessions,
  numberValue,
  resumeSession,
  type SessionHistoryItem,
  type SessionStatus
} from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "long",
    year: "numeric"
  }).format(new Date(value));
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function statusVariant(status: SessionStatus) {
  if (status === "COMPLETE" || status === "COMPLETED") {
    return "success";
  }

  // Cancelled analyses are a neutral/grey state, not an error.
  if (status === "CANCELLED") {
    return "secondary";
  }

  if (status === "FAILED") {
    return "destructive";
  }

  if (status === "SAMPLING" || status === "EXTRACTING") {
    return "warning";
  }

  return "secondary";
}

function statusLabel(status: SessionStatus) {
  return status === "CANCELLED" ? "Cancelled" : status;
}

function scorePillClass(score: number) {
  if (score >= 80) {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }

  if (score >= 50) {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }

  return "border-red-200 bg-red-50 text-red-700";
}

export default function SessionsHistoryPage() {
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionHistoryItem[]>([]);
  const [selectedSession, setSelectedSession] =
    useState<SessionHistoryItem | null>(null);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isDeleting, setIsDeleting] = useState(false);
  const [resumingId, setResumingId] = useState<string | null>(null);

  async function handleResume(sessionId: string) {
    setResumingId(sessionId);

    try {
      await resumeSession(sessionId);
      router.push(`/sessions/${sessionId}`);
    } catch (nextError) {
      setError(
        friendlyApiErrorMessage(nextError, "Unable to resume this session.")
      );
      setResumingId(null);
    }
  }

  async function loadSessions() {
    setIsLoading(true);

    try {
      const nextSessions = await getSessions();

      setSessions(nextSessions);
      setError("");
    } catch (nextError) {
      setError(
        friendlyApiErrorMessage(nextError, "Unable to load session history.")
      );
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadSessions();
  }, []);

  const hasSessions = sessions.length > 0;
  const rows = useMemo(
    () =>
      sessions.map((session) => ({
        ...session,
        totalUrls: numberValue(session.total_urls),
        patternCount: numberValue(session.pattern_count),
        healthyCount: numberValue(session.healthy_count),
        warningCount: numberValue(session.warning_count),
        brokenCount: numberValue(session.broken_count),
        healthScore: numberValue(session.health_score),
        emptySitemapCount: numberValue(session.empty_sitemap_count)
      })),
    [sessions]
  );
  const historySummary = useMemo(() => {
    const totalUrls = rows.reduce(
      (total, session) => total + session.totalUrls,
      0
    );
    const averageHealthScore =
      rows.length === 0
        ? 0
        : Math.round(
            rows.reduce((total, session) => total + session.healthScore, 0) /
              rows.length
          );

    return {
      totalSessions: rows.length,
      totalUrls,
      averageHealthScore
    };
  }, [rows]);

  async function confirmDelete() {
    if (!selectedSession) {
      return;
    }

    setIsDeleting(true);

    try {
      await deleteSession(selectedSession.id);
      setSessions((current) =>
        current.filter((session) => session.id !== selectedSession.id)
      );
      setSelectedSession(null);
      setError("");
    } catch (nextError) {
      setError(friendlyApiErrorMessage(nextError, "Unable to delete session."));
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <main className="min-h-[calc(100vh-56px)] bg-slate-50">
      <section className="mx-auto flex w-full max-w-7xl flex-col px-4 py-8 sm:px-6 lg:px-8">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">
              Analysis history
            </h1>
            <p className="mt-2 text-sm text-slate-500">
              Reopen past sitemap checks without uploading again.
            </p>
          </div>
          <Button asChild>
            <Link href="/">
              <Plus className="mr-2 h-4 w-4" />
              New Analysis
            </Link>
          </Button>
        </div>

        <div className="mb-6 grid gap-3 md:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
            <p className="text-xs font-semibold uppercase text-slate-500">
              Total sessions
            </p>
            <p className="mt-1 text-2xl font-bold text-slate-900">
              {formatNumber(historySummary.totalSessions)}
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
            <p className="text-xs font-semibold uppercase text-slate-500">
              URLs analysed
            </p>
            <p className="mt-1 text-2xl font-bold text-slate-900">
              {formatNumber(historySummary.totalUrls)}
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
            <p className="text-xs font-semibold uppercase text-slate-500">
              Average health score
            </p>
            <div className="mt-2">
              <span
                className={`inline-flex rounded-full border px-3 py-1 text-sm font-semibold ${scorePillClass(
                  historySummary.averageHealthScore
                )}`}
              >
                {historySummary.averageHealthScore}/100
              </span>
            </div>
          </div>
        </div>

        <div className="space-y-6">
          {error ? (
            <div
              className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              {error}
            </div>
          ) : null}

          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading history
            </div>
          ) : null}

          {!isLoading && !hasSessions ? (
            <Card>
              <CardHeader>
                <CardTitle>No analyses yet</CardTitle>
                <CardDescription>
                  Start a new analysis to build your history.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button asChild>
                  <Link href="/">Start analysis</Link>
                </Button>
              </CardContent>
            </Card>
          ) : null}

          {hasSessions ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base font-semibold text-slate-700">
                  Past analyses
                </CardTitle>
                <CardDescription className="text-sm text-slate-500">
                  Sessions are ordered newest first.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto rounded-xl border border-slate-200">
                  <table className="w-full min-w-[1160px] border-collapse text-sm">
                    <thead className="bg-slate-50">
                      <tr>
                        <th className="border-b border-slate-200 px-3 py-3 text-left text-xs font-semibold uppercase text-slate-500">
                          Session
                        </th>
                        <th className="border-b border-slate-200 px-3 py-3 text-left text-xs font-semibold uppercase text-slate-500">
                          Date
                        </th>
                        <th className="border-b border-slate-200 px-3 py-3 text-left text-xs font-semibold uppercase text-slate-500">
                          Status
                        </th>
                        <th className="border-b border-slate-200 px-3 py-3 text-left text-xs font-semibold uppercase text-slate-500">
                          Health
                        </th>
                        <th className="border-b border-slate-200 px-3 py-3 text-left text-xs font-semibold uppercase text-slate-500">
                          Patterns
                        </th>
                        <th className="border-b border-slate-200 px-3 py-3 text-left text-xs font-semibold uppercase text-slate-500">
                          Total URLs
                        </th>
                        <th className="border-b border-slate-200 px-3 py-3 text-left text-xs font-semibold uppercase text-slate-500">
                          Empty sitemaps
                        </th>
                        <th className="border-b border-slate-200 px-3 py-3 text-left text-xs font-semibold uppercase text-slate-500">
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((session) => {
                        // Cancelled sessions have no saved results to reopen.
                        const canOpen = session.status !== "CANCELLED";

                        return (
                        <tr
                          key={session.id}
                          data-session-row={session.id}
                          tabIndex={0}
                          className={cn(
                            "group border-b border-slate-100 bg-white transition-colors focus:outline-none",
                            canOpen
                              ? "cursor-pointer hover:bg-indigo-50/50 focus:bg-indigo-50/50"
                              : "cursor-default"
                          )}
                          onClick={() => {
                            if (canOpen) {
                              router.push(`/sessions/${session.id}/results`);
                            }
                          }}
                          onKeyDown={(event) => {
                            if (
                              canOpen &&
                              (event.key === "Enter" || event.key === " ")
                            ) {
                              event.preventDefault();
                              router.push(`/sessions/${session.id}/results`);
                            }
                          }}
                        >
                          <td className="relative max-w-80 px-4 py-3 before:absolute before:left-0 before:top-0 before:h-full before:w-1 before:origin-top before:scale-y-0 before:bg-indigo-500 before:transition-transform before:duration-200 before:content-[''] group-hover:before:scale-y-100 group-focus:before:scale-y-100">
                            {canOpen ? (
                              <Link
                                href={`/sessions/${session.id}/results`}
                                className="block font-semibold text-slate-900 hover:text-indigo-700"
                              >
                                {session.name}
                              </Link>
                            ) : (
                              <span className="block font-semibold text-slate-900">
                                {session.name}
                              </span>
                            )}
                            <p className="mt-1 break-all font-mono text-xs text-slate-500">
                              {session.base_url}
                            </p>
                          </td>
                          <td className="px-3 py-3 text-slate-500">
                            <div className="flex items-center gap-2">
                              <CalendarDays className="h-4 w-4" />
                              {formatDate(session.created_at)}
                            </div>
                          </td>
                          <td className="px-3 py-3">
                            <Badge variant={statusVariant(session.status)}>
                              {statusLabel(session.status)}
                            </Badge>
                          </td>
                          <td className="px-3 py-3">
                            <span
                              className={`inline-flex rounded-full border px-3 py-1 text-sm font-semibold ${scorePillClass(
                                session.healthScore
                              )}`}
                            >
                              {session.healthScore}/100
                            </span>
                          </td>
                          <td className="px-3 py-3">
                            <div className="flex flex-wrap gap-1">
                              <Badge variant="secondary">
                                {formatNumber(session.patternCount)} total
                              </Badge>
                              <Badge variant="success">
                                {formatNumber(session.healthyCount)} healthy
                              </Badge>
                              <Badge variant="warning">
                                {formatNumber(session.warningCount)} warning
                              </Badge>
                              <Badge variant="destructive">
                                {formatNumber(session.brokenCount)} broken
                              </Badge>
                            </div>
                          </td>
                          <td className="px-3 py-3">
                            {formatNumber(session.totalUrls)}
                          </td>
                          <td className="px-3 py-3">
                            <Badge
                              variant={
                                session.emptySitemapCount > 0
                                  ? "warning"
                                  : "secondary"
                              }
                            >
                              {formatNumber(session.emptySitemapCount)}
                            </Badge>
                          </td>
                          <td className="px-3 py-3">
                            <div className="flex items-center gap-2">
                              {session.status === "FAILED" ? (
                                <Button
                                  type="button"
                                  size="sm"
                                  className="bg-indigo-600 text-white hover:bg-indigo-700"
                                  disabled={resumingId === session.id}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void handleResume(session.id);
                                  }}
                                >
                                  {resumingId === session.id ? (
                                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                                  ) : (
                                    <RefreshCw className="mr-2 h-3.5 w-3.5" />
                                  )}
                                  Resume
                                </Button>
                              ) : null}
                              {canOpen ? (
                                <Button
                                  asChild
                                  size="sm"
                                  variant="outline"
                                  className="border-indigo-200 text-indigo-700 hover:bg-indigo-50 hover:text-indigo-800"
                                >
                                  <Link
                                    href={`/sessions/${session.id}/results`}
                                    onClick={(event) => event.stopPropagation()}
                                  >
                                    Results
                                    <ArrowRight className="ml-2 h-3.5 w-3.5" />
                                  </Link>
                                </Button>
                              ) : (
                                <span className="text-sm text-slate-400">
                                  No results
                                </span>
                              )}
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="pointer-events-none text-red-600 opacity-0 transition-opacity hover:bg-red-50 hover:text-red-700 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
                                aria-label={`Delete ${session.name}`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setSelectedSession(session);
                                }}
                              >
                                <Trash2 className="h-4 w-4" />
                                <span className="sr-only">
                                  Delete {session.name}
                                </span>
                              </Button>
                            </div>
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </section>

      <Dialog
        open={selectedSession !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedSession(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this analysis?</DialogTitle>
            <DialogDescription>
              {selectedSession
                ? `This removes "${selectedSession.name}" and its saved results.`
                : "This removes the selected analysis and its saved results."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={isDeleting}
              onClick={() => void confirmDelete()}
            >
              {isDeleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Deleting
                </>
              ) : (
                "Delete"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
