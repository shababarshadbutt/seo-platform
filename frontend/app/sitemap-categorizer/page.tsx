"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Download,
  FolderTree,
  Loader2,
  RefreshCcw
} from "lucide-react";

import {
  createCategorizerSession,
  downloadCategorizer404s,
  downloadCategorizerZip,
  friendlyApiErrorMessage,
  getCategorizerCategories,
  getCategorizerOutputFiles,
  getCategorizerPhaseStatus,
  getS3Domains,
  getSftpDomains,
  startCategorizerPhase,
  type CategorizerCategorySummary,
  type CategorizerJobStatus,
  type CategorizerOutputFile,
  type CategorizerPhase,
  type CategorizerSession,
  type CategorizerSourceKind
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";

// Per categorizerMaxUrlsPerFile.ts — kept in sync by hand since this is a
// frontend-only bound check (the backend is authoritative and re-validates).
const MIN_URLS_PER_FILE = 10_000;
const MAX_URLS_PER_FILE = 100_000;
const URLS_PER_FILE_STEP = 5_000;
const DEFAULT_URLS_PER_FILE = 45_000;

const POLL_INTERVAL_MS = 3000;

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function isPhaseActive(job: CategorizerJobStatus | null) {
  return job?.status === "PENDING" || job?.status === "RUNNING";
}

// A durable-job progress card: polls one phase's status row every few seconds
// (not SSE — a status-check run can span hours to days, which is a poor fit
// for a stream the browser tab may not stay open for) and renders a progress
// bar, a start/resume button, or a terminal state.
function PhaseCard({
  step,
  title,
  description,
  sessionId,
  phase,
  confirmBeforeStart,
  disabled,
  onComplete,
  renderAfterComplete
}: {
  step: number;
  title: string;
  description: string;
  sessionId: string;
  phase: CategorizerPhase;
  confirmBeforeStart?: { title: string; description: string };
  disabled?: boolean;
  onComplete?: () => void;
  renderAfterComplete?: React.ReactNode;
}) {
  const [job, setJob] = useState<CategorizerJobStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const notifiedComplete = useRef(false);

  const poll = useCallback(async () => {
    try {
      const status = await getCategorizerPhaseStatus(sessionId, phase);

      setJob(status);

      if (status?.status === "COMPLETE" && !notifiedComplete.current) {
        notifiedComplete.current = true;
        onComplete?.();
      }
    } catch {
      // A poll failure is transient — keep showing the last known state.
    }
  }, [sessionId, phase, onComplete]);

  useEffect(() => {
    void poll();

    const interval = window.setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [poll]);

  async function start() {
    setLoading(true);
    setError("");

    try {
      await startCategorizerPhase(sessionId, phase);
      await poll();
    } catch (err) {
      setError(friendlyApiErrorMessage(err, "Unable to start this phase."));
    } finally {
      setLoading(false);
    }
  }

  const total = Number(job?.items_total ?? 0);
  const done = Number(job?.items_done ?? 0);
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  const active = isPhaseActive(job);
  const complete = job?.status === "COMPLETE";
  const failed = job?.status === "FAILED";

  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="text-base">
          {step}. {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!job || (!active && !complete) ? (
          <Button
            type="button"
            disabled={disabled || loading}
            onClick={() => {
              if (confirmBeforeStart) {
                setConfirmOpen(true);
              } else {
                void start();
              }
            }}
            className="gap-2"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {failed ? "Retry" : "Start"}
          </Button>
        ) : null}

        {active ? (
          <div className="space-y-2">
            <p className="flex items-center gap-2 text-sm text-slate-700">
              <Loader2 className="h-4 w-4 animate-spin" />
              {total > 0
                ? `${formatNumber(done)} of ${formatNumber(total)}`
                : "Working…"}
            </p>
            {total > 0 ? <Progress value={percent} /> : null}
          </div>
        ) : null}

        {complete ? (
          <div className="space-y-3">
            <p className="flex items-center gap-2 text-sm font-medium text-emerald-700">
              <CheckCircle2 className="h-4 w-4" />
              {total > 0
                ? `Done — ${formatNumber(total)} URL(s)`
                : "Done"}
            </p>
            {renderAfterComplete}
          </div>
        ) : null}

        {failed ? (
          <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{job?.error ?? "This phase failed."}</span>
          </div>
        ) : null}

        {error ? (
          <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}
      </CardContent>

      {confirmBeforeStart ? (
        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{confirmBeforeStart.title}</DialogTitle>
              <DialogDescription>{confirmBeforeStart.description}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setConfirmOpen(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => {
                  setConfirmOpen(false);
                  void start();
                }}
              >
                Start
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </Card>
  );
}

function CategoriesPreview({ sessionId }: { sessionId: string }) {
  const [categories, setCategories] = useState<CategorizerCategorySummary[] | null>(null);

  useEffect(() => {
    let cancelled = false;

    void getCategorizerCategories(sessionId).then((result) => {
      if (!cancelled) {
        setCategories(result);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (!categories || categories.length === 0) {
    return null;
  }

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-3 py-2">Category</th>
            <th className="px-3 py-2 text-right">URLs</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {categories.map((category) => (
            <tr key={category.category}>
              <td className="px-3 py-2 font-mono text-xs text-slate-700">
                {category.category}.xml
              </td>
              <td className="px-3 py-2 text-right text-slate-700">
                {formatNumber(category.urlCount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OutputFilesAndDownload({
  sessionId,
  domain
}: {
  sessionId: string;
  domain: string;
}) {
  const [files, setFiles] = useState<CategorizerOutputFile[] | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");

  useEffect(() => {
    let cancelled = false;

    void getCategorizerOutputFiles(sessionId).then((result) => {
      if (!cancelled) {
        setFiles(result);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  async function handleDownloadZip() {
    setDownloading(true);
    setDownloadError("");

    try {
      await downloadCategorizerZip(sessionId, domain);
    } catch (err) {
      setDownloadError(friendlyApiErrorMessage(err, "Unable to download the sitemap files."));
    } finally {
      setDownloading(false);
    }
  }

  async function handleDownload404s() {
    setDownloading(true);
    setDownloadError("");

    try {
      await downloadCategorizer404s(sessionId, domain);
    } catch (err) {
      setDownloadError(friendlyApiErrorMessage(err, "Unable to download the 404 list."));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="space-y-3">
      {files && files.length > 0 ? (
        <p className="text-sm text-slate-600">
          {formatNumber(files.length)} file(s) generated, plus sitemap-index.xml.
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => void handleDownloadZip()} disabled={downloading} className="gap-2">
          <Download className="h-4 w-4" />
          Download sitemap ZIP
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => void handleDownload404s()}
          disabled={downloading}
          className="gap-2"
        >
          <Download className="h-4 w-4" />
          Download 404 URLs
        </Button>
      </div>

      {downloadError ? (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{downloadError}</span>
        </div>
      ) : null}
    </div>
  );
}

export default function SitemapCategorizerPage() {
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [sourceKind, setSourceKind] = useState<CategorizerSourceKind>("s3");
  const [domains, setDomains] = useState<string[]>([]);
  const [domainsLoading, setDomainsLoading] = useState(false);
  const [domainsError, setDomainsError] = useState("");
  const [selectedDomain, setSelectedDomain] = useState("");
  const [maxUrlsPerFile, setMaxUrlsPerFile] = useState(DEFAULT_URLS_PER_FILE);

  const [session, setSession] = useState<CategorizerSession | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  useEffect(() => {
    let cancelled = false;

    setDomainsLoading(true);
    setDomainsError("");
    setSelectedDomain("");

    const list = sourceKind === "s3" ? getS3Domains() : getSftpDomains();

    void list
      .then((result) => {
        if (!cancelled) {
          setDomains(result.domains ?? []);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setDomainsError(
            friendlyApiErrorMessage(err, "Unable to list available domains.")
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setDomainsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [sourceKind]);

  async function handleCreateAndStart() {
    if (!name.trim() || !baseUrl.trim() || !selectedDomain) {
      return;
    }

    setCreating(true);
    setCreateError("");

    try {
      const created = await createCategorizerSession({
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        sourceKind,
        sourceDomain: selectedDomain,
        maxUrlsPerFile
      });

      setSession(created);
      await startCategorizerPhase(created.id, "ingest");
    } catch (err) {
      setCreateError(friendlyApiErrorMessage(err, "Unable to create this session."));
    } finally {
      setCreating(false);
    }
  }

  const [ingestDone, setIngestDone] = useState(false);
  const [statusCheckDone, setStatusCheckDone] = useState(false);
  const [categorizeDone, setCategorizeDone] = useState(false);

  return (
    <main className="min-h-[calc(100vh-56px)] bg-[#F8FAFC]">
      <section className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="mb-6">
          <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900 sm:text-3xl">
            <FolderTree className="h-6 w-6 text-indigo-500" aria-hidden="true" />
            Sitemap Categorizer
          </h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Pull every URL from a site&rsquo;s existing sitemaps, check the status
            of every one, automatically categorize the survivors by path
            structure, and generate a clean, capped-size sitemap set with an
            index — ready for Google Search Console.
          </p>
        </div>

        {!session ? (
          <Card className="mb-4">
            <CardHeader>
              <CardTitle className="text-base">1. Site</CardTitle>
              <CardDescription>
                Choose the site whose sitemaps this will read and categorize.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-slate-700">Session name</label>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="e.g. Aero World Fulfillment — full categorization"
                  className="h-11 w-full rounded-lg border border-slate-200 px-3 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium text-slate-700">Site base URL</label>
                <input
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder="https://www.example.com"
                  className="h-11 w-full rounded-lg border border-slate-200 px-3 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium text-slate-700">Source</label>
                <div className="flex gap-2">
                  {(["s3", "sftp"] as const).map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      onClick={() => setSourceKind(kind)}
                      className={`h-9 rounded-md px-3.5 text-sm font-medium transition-colors ${
                        sourceKind === kind
                          ? "bg-indigo-500 text-white"
                          : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                      }`}
                    >
                      {kind === "s3" ? "S3" : "SFTP"}
                    </button>
                  ))}
                </div>
              </div>

              {domainsLoading ? (
                <p className="text-sm text-slate-500">Listing domains…</p>
              ) : domainsError ? (
                <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  {domainsError}
                </p>
              ) : (
                <select
                  value={selectedDomain}
                  onChange={(event) => setSelectedDomain(event.target.value)}
                  className="h-11 w-full rounded-lg border border-slate-200 px-3 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none"
                >
                  <option value="">Select a domain…</option>
                  {domains.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              )}

              <div className="space-y-1.5">
                <label className="text-sm font-medium text-slate-700">
                  Max URLs per output file
                </label>
                <input
                  type="range"
                  min={MIN_URLS_PER_FILE}
                  max={MAX_URLS_PER_FILE}
                  step={URLS_PER_FILE_STEP}
                  value={maxUrlsPerFile}
                  onChange={(event) => setMaxUrlsPerFile(Number(event.target.value))}
                  className="w-full"
                />
                <p className="text-sm text-slate-500">
                  {formatNumber(maxUrlsPerFile)} URLs per file
                </p>
              </div>

              <Button
                type="button"
                onClick={() => void handleCreateAndStart()}
                disabled={!name.trim() || !baseUrl.trim() || !selectedDomain || creating}
                className="gap-2"
              >
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Create session &amp; start ingest
              </Button>

              {createError ? (
                <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{createError}</span>
                </div>
              ) : null}
            </CardContent>
          </Card>
        ) : (
          <>
            <Card className="mb-4 bg-slate-50">
              <CardContent className="flex items-center justify-between py-4">
                <div>
                  <p className="text-sm font-semibold text-slate-900">{session.name}</p>
                  <p className="text-xs text-slate-500">
                    {session.source_domain} ({session.source_kind.toUpperCase()})
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => window.location.reload()}
                  className="gap-2"
                >
                  <RefreshCcw className="h-3.5 w-3.5" />
                  New session
                </Button>
              </CardContent>
            </Card>

            <PhaseCard
              step={2}
              title="Ingest"
              description="Pull every sitemap file for this domain and extract its URLs."
              sessionId={session.id}
              phase="ingest"
              onComplete={() => setIngestDone(true)}
            />

            <PhaseCard
              step={3}
              title="Check status"
              description="Check the HTTP status of every ingested URL. 404s are excluded from every output file."
              sessionId={session.id}
              phase="status-check"
              disabled={!ingestDone}
              confirmBeforeStart={{
                title: "Start checking every URL?",
                description:
                  "This checks the status of every URL, not a sample, and can take a long time on a large site. It runs in the background and can be revisited later — this tab does not need to stay open."
              }}
              onComplete={() => setStatusCheckDone(true)}
            />

            <PhaseCard
              step={4}
              title="Categorize"
              description="Classify every non-404 URL by path structure (regular pages, static listings, and RFQ shapes)."
              sessionId={session.id}
              phase="categorize"
              disabled={!statusCheckDone}
              onComplete={() => setCategorizeDone(true)}
              renderAfterComplete={<CategoriesPreview sessionId={session.id} />}
            />

            <PhaseCard
              step={5}
              title="Generate &amp; download"
              description="Write the final capped-size sitemap files and a sitemap-index.xml."
              sessionId={session.id}
              phase="generate"
              disabled={!categorizeDone}
              renderAfterComplete={
                <OutputFilesAndDownload
                  sessionId={session.id}
                  domain={session.source_domain}
                />
              }
            />
          </>
        )}
      </section>
    </main>
  );
}
