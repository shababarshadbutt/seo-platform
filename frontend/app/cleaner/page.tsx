"use client";

import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Download,
  FileText,
  Loader2,
  Map as MapIcon,
  Sparkles,
  UploadCloud,
  X
} from "lucide-react";

import {
  apiErrorPayload,
  downloadCleanerZip,
  downloadDuplicatesCsv,
  friendlyApiErrorMessage,
  getRuntimeConfig,
  getSftpDomains,
  processCleaner,
  processCleanerFromSftp,
  type CleanerDropReason,
  type CleanerProgressEvent,
  type CleanerSummary
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";

type Phase = "idle" | "processing" | "done" | "error";

const ACCEPTED = /\.(xml|zip)$/i;

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function isValidDomain(value: string) {
  try {
    const url = new URL(value.trim());

    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

const DROP_REASON_LABEL: Record<CleanerDropReason, string> = {
  empty: "Empty after cleaning",
  wrong_domain: "Wrong domain",
  unparsable: "Could not parse"
};

export default function CleanerPage() {
  // Source of the sitemaps to clean. "upload" is the original behaviour; "sftp"
  // pulls the domain's folder server-side, reusing Migration's SFTP backend.
  const [sourceMode, setSourceMode] = useState<"upload" | "sftp">("upload");
  const [sftpDomains, setSftpDomains] = useState<string[]>([]);
  const [sftpDomain, setSftpDomain] = useState("");
  const [sftpLoading, setSftpLoading] = useState(false);
  const [sftpError, setSftpError] = useState("");
  // Gated exactly like Migration's SFTP tab: absent unless AWS_PUBLISH_ENABLED.
  const [awsPublishEnabled, setAwsPublishEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void getRuntimeConfig().then((runtimeConfig) => {
      if (!cancelled) {
        setAwsPublishEnabled(runtimeConfig.awsPublishEnabled);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  async function loadSftpDomains() {
    setSftpLoading(true);
    setSftpError("");

    try {
      setSftpDomains((await getSftpDomains()).domains);
    } catch (loadError) {
      setSftpError(
        friendlyApiErrorMessage(loadError, "Could not list SFTP domains.")
      );
    } finally {
      setSftpLoading(false);
    }
  }

  const [domain, setDomain] = useState("");
  const [subfolder, setSubfolder] = useState("sitemaps");
  const [files, setFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  // True while a dropped SFTP-clean stream is being reattached. Distinct from
  // `phase`: the run is still processing, only our view of it lapsed, so this
  // must not read as an error state.
  const [reconnecting, setReconnecting] = useState(false);
  const [progressMessage, setProgressMessage] = useState("");
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(
    null
  );
  const [summary, setSummary] = useState<CleanerSummary | null>(null);
  const [downloadToken, setDownloadToken] = useState("");
  const [zipFilename, setZipFilename] = useState("cleaned-sitemaps.zip");
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const domainValid = isValidDomain(domain);
  const cleanBase = domain.trim().replace(/\/+$/, "");
  const cleanSub = subfolder.trim().replace(/^\/+|\/+$/g, "");
  const urlPattern = cleanBase
    ? `${cleanBase}${cleanSub ? `/${cleanSub}` : ""}/{filename}.xml`
    : "https://www.domain.com/sitemaps/{filename}.xml";

  const canClean =
    domainValid &&
    phase !== "processing" &&
    (sourceMode === "upload" ? files.length > 0 : sftpDomain.length > 0);

  function addFiles(incoming: FileList | File[]) {
    const accepted = Array.from(incoming).filter((file) =>
      ACCEPTED.test(file.name)
    );

    if (accepted.length === 0) {
      return;
    }

    setFiles((current) => {
      // De-dupe by name+size so re-selecting the same folder doesn't stack.
      const seen = new Set(current.map((file) => `${file.name}:${file.size}`));
      const merged = [...current];

      for (const file of accepted) {
        const key = `${file.name}:${file.size}`;

        if (!seen.has(key)) {
          seen.add(key);
          merged.push(file);
        }
      }

      return merged;
    });
  }

  function handleFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    if (event.target.files) {
      addFiles(event.target.files);
    }

    event.target.value = "";
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);

    if (event.dataTransfer.files) {
      addFiles(event.dataTransfer.files);
    }
  }

  function removeFile(index: number) {
    setFiles((current) => current.filter((_, i) => i !== index));
  }

  function resetResults() {
    setSummary(null);
    setDownloadToken("");
    setError("");
    setProgress(null);
    setProgressMessage("");
    setReconnecting(false);
  }

  async function handleClean() {
    if (!canClean) {
      return;
    }

    resetResults();
    setPhase("processing");

    // SFTP source: no upload at all — the backend pulls the folder and runs the
    // same clean, emitting the same SSE frames (including the done frame with a
    // download_token, which is what the existing Migration handoff consumes).
    if (sourceMode === "sftp") {
      try {
        const done = await processCleanerFromSftp(
          {
            domain: sftpDomain,
            siteUrl: domain.trim(),
            subfolder: cleanSub || "sitemaps"
          },
          (event: CleanerProgressEvent) => {
            if (event.type === "progress") {
              setProgressMessage(event.message);
              setReconnecting(false);
              setProgress(
                typeof event.current === "number" &&
                  typeof event.total === "number"
                  ? { current: event.current, total: event.total }
                  : null
              );
            } else if (event.type === "reconnecting") {
              // A dropped stream is NOT a failure: the run is independent of the
              // connection and is still going. Say so, keep the last known
              // progress on screen, and stay in the processing phase.
              setReconnecting(true);
              setProgressMessage(
                `Connection lost — reconnecting to the run (attempt ${event.attempt} of ${event.max_attempts})…`
              );
            }
          }
        );

        setSummary(done.summary);
        setDownloadToken(done.download_token);
        setZipFilename(done.zip_filename);
        setReconnecting(false);
        setPhase("done");
      } catch (sftpRunError) {
        setReconnecting(false);
        setError(
          friendlyApiErrorMessage(sftpRunError, "Cleaning from SFTP failed.")
        );
        setPhase("error");
      }

      return;
    }

    const formData = new FormData();
    formData.append("domain", domain.trim());
    formData.append("subfolder", cleanSub || "sitemaps");
    // Send the selected-file count BEFORE the files so the backend can show an
    // "X of Y" upload progress bar as each file spools to disk, instead of a
    // countless spinner during the (slow, for 2000+ files) upload phase. (v1.43)
    formData.append("fileCount", String(files.length));

    for (const file of files) {
      formData.append("files", file, file.name);
    }

    try {
      const done = await processCleaner(formData, (event: CleanerProgressEvent) => {
        if (event.type === "progress") {
          setProgressMessage(event.message);
          setProgress(
            typeof event.current === "number" && typeof event.total === "number"
              ? { current: event.current, total: event.total }
              : null
          );
        }
      });

      setSummary(done.summary);
      setDownloadToken(done.download_token);
      setZipFilename(done.zip_filename);
      setPhase("done");
    } catch (nextError) {
      // A dropped SSE stream must NOT read as "Cannot connect to backend" — the
      // backend is up, the long-running stream just closed. (v1.37 Fix 1)
      const payload = apiErrorPayload(nextError) as { code?: string } | null;

      if (payload?.code === "stream_closed") {
        setError(
          "Processing stream closed before finishing — the server may still be working. Wait a moment and try again, or upload fewer files at once."
        );
      } else {
        setError(friendlyApiErrorMessage(nextError, "Cleaning failed."));
      }

      setPhase("error");
    }
  }

  const migrationHandoffUrl = downloadToken
    ? `/migration?domain=${encodeURIComponent(domain.trim())}&source=cleaner&token=${encodeURIComponent(
        downloadToken
      )}`
    : "";

  async function handleDownloadZip() {
    if (!downloadToken) {
      return;
    }

    try {
      await downloadCleanerZip(downloadToken, zipFilename);
    } catch (nextError) {
      setError(friendlyApiErrorMessage(nextError, "Could not download the ZIP."));
    }
  }

  async function handleDownloadCsv() {
    if (!summary) {
      return;
    }

    try {
      await downloadDuplicatesCsv(
        summary.duplicate_urls,
        zipFilename.replace(/\.zip$/i, "").replace(/^cleaned-sitemaps/, "duplicates-report") +
          ".csv"
      );
    } catch (nextError) {
      setError(friendlyApiErrorMessage(nextError, "Could not download the CSV."));
    }
  }

  const progressPercent =
    progress && progress.total > 0
      ? Math.round((progress.current / progress.total) * 100)
      : null;

  // Derived counts for the reference-style summary tiles. "Sitemaps found" is
  // every uploaded sitemap: the processed files plus the index files (which are
  // rebuilt, not "processed"). Wrong-domain / empty skip counts are broken out
  // of dropped_files so they get their own visible tiles.
  const wrongDomainSkipped =
    summary?.dropped_files.filter((file) => file.reason === "wrong_domain")
      .length ?? 0;
  const emptySkipped =
    summary?.dropped_files.filter((file) => file.reason === "empty").length ??
    0;
  const sitemapsFound = summary
    ? summary.files_processed + summary.index_files_detected
    : 0;

  return (
    <main className="min-h-[calc(100vh-56px)] bg-[#F8FAFC]">
      <section className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="mb-6">
          <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900 sm:text-3xl">
            <Sparkles className="h-6 w-6 text-indigo-500" aria-hidden="true" />
            Sitemap Cleaner
          </h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Removes duplicate URLs, drops wrong-domain and empty sitemaps, and
            rebuilds the sitemap index.
          </p>
        </div>

        {/* Settings */}
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">Settings</CardTitle>
            <CardDescription>
              Only URLs belonging to this domain are kept.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <label
                htmlFor="cleaner-domain"
                className="text-sm font-medium text-slate-700"
              >
                Website domain (no trailing slash)
              </label>
              <Input
                id="cleaner-domain"
                value={domain}
                onChange={(event) => setDomain(event.target.value)}
                placeholder="https://www.integratedpartsprocurement.com"
                className={cn(
                  domain && !domainValid && "border-red-400 focus-visible:ring-red-400"
                )}
              />
              {domain && !domainValid ? (
                <p className="text-xs text-red-500">
                  Enter a full URL including https://
                </p>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="cleaner-subfolder"
                className="text-sm font-medium text-slate-700"
              >
                URL subfolder for sitemaps
              </label>
              <Input
                id="cleaner-subfolder"
                value={subfolder}
                onChange={(event) => setSubfolder(event.target.value)}
                placeholder="sitemaps"
              />
              <p className="text-xs text-slate-500">
                Resulting URL pattern:{" "}
                <span className="font-mono text-slate-700">{urlPattern}</span>
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Upload */}
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">Upload</CardTitle>
            <CardDescription>
              Drag and drop or click to select multiple XML files. Large folders:
              zip them first, then upload the ZIP.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {/* Source picker. Only appears when AWS_PUBLISH_ENABLED is on, the
                same gate Migration's From SFTP tab uses — with the flag off the
                Cleaner looks and behaves exactly as before. */}
            {awsPublishEnabled ? (
              <div
                className="mb-4 grid grid-cols-2 gap-1 rounded-full border border-indigo-100 bg-indigo-50 p-1"
                role="tablist"
                aria-label="Sitemap source"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={sourceMode === "upload"}
                  onClick={() => setSourceMode("upload")}
                  className={cn(
                    "flex h-9 items-center justify-center gap-2 rounded-full text-sm font-semibold transition-colors",
                    sourceMode === "upload"
                      ? "bg-indigo-500 text-white shadow-sm"
                      : "text-slate-500 hover:text-indigo-600"
                  )}
                >
                  Upload Files
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={sourceMode === "sftp"}
                  onClick={() => {
                    setSourceMode("sftp");

                    if (sftpDomains.length === 0 && !sftpLoading) {
                      void loadSftpDomains();
                    }
                  }}
                  className={cn(
                    "flex h-9 items-center justify-center gap-2 rounded-full text-sm font-semibold transition-colors",
                    sourceMode === "sftp"
                      ? "bg-indigo-500 text-white shadow-sm"
                      : "text-slate-500 hover:text-indigo-600"
                  )}
                >
                  From SFTP
                </button>
              </div>
            ) : null}

            {awsPublishEnabled && sourceMode === "sftp" ? (
              <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="space-y-1">
                  <label
                    className="text-sm font-semibold text-slate-700"
                    htmlFor="cleaner-sftp-domain"
                  >
                    Client domain
                  </label>
                  <p className="text-xs text-slate-500">
                    Pulls every sitemap file for this domain from the SFTP
                    location and cleans them — nothing is uploaded from here.
                  </p>
                </div>

                {sftpLoading ? (
                  <p className="text-sm text-slate-500">Listing domains…</p>
                ) : sftpError ? (
                  <div className="space-y-2">
                    <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
                      {sftpError}
                    </p>
                    <button
                      type="button"
                      className="text-sm font-semibold text-indigo-600 hover:text-indigo-700"
                      onClick={() => void loadSftpDomains()}
                    >
                      Try again
                    </button>
                  </div>
                ) : (
                  <>
                    <select
                      id="cleaner-sftp-domain"
                      value={sftpDomain}
                      onChange={(event) => setSftpDomain(event.target.value)}
                      className="h-11 w-full rounded-lg border border-slate-200 px-3 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none"
                    >
                      <option value="">Select a domain…</option>
                      {sftpDomains.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                    {sftpDomains.length === 0 ? (
                      <p className="text-sm text-slate-500">
                        No domains found in the SFTP location.
                      </p>
                    ) : null}
                    <p className="text-sm text-slate-500">
                      The Domain field above is still what the cleaned{" "}
                      <code>&lt;loc&gt;</code> values are written against.
                    </p>
                  </>
                )}
              </div>
            ) : (
            <div
              role="button"
              tabIndex={0}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              onDragOver={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              className={cn(
                "flex min-h-40 cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed px-4 py-6 text-center transition-colors",
                isDragging
                  ? "border-indigo-400 bg-indigo-100"
                  : "border-indigo-300/70 bg-indigo-50/60 hover:bg-indigo-100/60"
              )}
            >
              <input
                ref={fileInputRef}
                data-testid="cleaner-file-input"
                type="file"
                accept=".xml,.zip,text/xml,application/xml,application/zip"
                multiple
                className="hidden"
                onChange={handleFileInputChange}
              />
              {files.length > 0 ? (
                <>
                  <FileText className="h-8 w-8 text-indigo-500" aria-hidden="true" />
                  <p className="mt-3 text-sm font-semibold text-slate-900">
                    {files.length} file{files.length === 1 ? "" : "s"} selected
                  </p>
                  <p className="text-xs text-slate-500">
                    Click to add more, or remove entries below
                  </p>
                </>
              ) : (
                <>
                  <UploadCloud
                    className="h-8 w-8 text-indigo-500"
                    aria-hidden="true"
                  />
                  <p className="mt-3 text-sm font-semibold text-slate-900">
                    Upload sitemap XML files
                  </p>
                  <p className="text-xs text-slate-500">
                    Accepts .xml and .zip
                  </p>
                </>
              )}
            </div>
            )}

            {sourceMode === "upload" && files.length > 0 ? (
              <ul className="mt-3 max-h-40 space-y-1 overflow-y-auto">
                {files.map((file, index) => (
                  <li
                    key={`${file.name}:${file.size}:${index}`}
                    className="flex items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-slate-700">
                      {file.name}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeFile(index)}
                      className="shrink-0 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                      aria-label={`Remove ${file.name}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </CardContent>
        </Card>

        {/* Process */}
        <div className="mb-4">
          <Button
            type="button"
            onClick={() => void handleClean()}
            disabled={!canClean}
            className="gap-2"
          >
            {phase === "processing" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            {phase === "processing" ? "Cleaning…" : "Clean Sitemaps"}
          </Button>
          {!domainValid && domain ? null : !domainValid ? (
            <p className="mt-2 text-xs text-slate-500">
              Enter a domain and add at least one file to enable cleaning.
            </p>
          ) : null}
        </div>

        {/* Progress */}
        {phase === "processing" ? (
          <Card className="mb-4">
            <CardContent className="space-y-2 py-4">
              <p
                className={`flex items-center gap-2 text-sm font-medium ${
                  reconnecting ? "text-amber-700" : "text-slate-700"
                }`}
                data-testid={
                  reconnecting ? "cleaner-reconnecting" : "cleaner-progress"
                }
              >
                <Loader2 className="h-4 w-4 animate-spin" />
                {progressMessage || "Processing…"}
              </p>
              {/* Amber, not red, and the spinner keeps turning: the run is still
                  going on the server, only our view of it lapsed. */}
              {reconnecting ? (
                <p className="text-xs text-amber-700">
                  The cleaning run is still going on the server. Your progress
                  view dropped out and is being reattached — you do not need to
                  start again.
                </p>
              ) : null}
              {progressPercent !== null ? (
                <Progress value={progressPercent} />
              ) : null}
              {progress && progress.total > 0 ? (
                <p className="text-xs text-slate-500">
                  {formatNumber(progress.current)} of{" "}
                  {formatNumber(progress.total)} processed
                  {progress.total - progress.current > 0
                    ? ` · ${formatNumber(
                        progress.total - progress.current
                      )} remaining`
                    : ""}
                </p>
              ) : null}
            </CardContent>
          </Card>
        ) : null}

        {/* Error */}
        {error ? (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {/* Results */}
        {phase === "done" && summary ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                Results
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <SummaryTile label="Sitemaps found" value={sitemapsFound} />
                <SummaryTile label="Sitemaps saved" value={summary.files_kept} />
                <SummaryTile
                  label="Sitemaps skipped (empty)"
                  value={emptySkipped}
                />
                <SummaryTile
                  label="Duplicate URLs removed"
                  value={summary.duplicates_removed}
                />
                <SummaryTile
                  label="Total URLs (kept files)"
                  value={summary.total_urls_kept_files}
                />
                <SummaryTile
                  label="Clean URLs remaining"
                  value={summary.clean_urls_remaining}
                />
                <SummaryTile
                  label="Reduction"
                  value={summary.reduction_pct}
                  display={`${summary.reduction_pct.toFixed(1)}%`}
                />
                <SummaryTile
                  label="Sitemaps skipped (wrong domain)"
                  value={wrongDomainSkipped}
                />
                <SummaryTile
                  label="Extra index files skipped"
                  value={summary.index_files_detected}
                />
              </div>

              {summary.index_files_detected > 0 ? (
                <p className="text-xs text-slate-500">
                  {formatNumber(summary.index_files_detected)} uploaded index
                  file
                  {summary.index_files_detected === 1 ? "" : "s"} replaced by the
                  rebuilt sitemap-index.xml.
                </p>
              ) : null}

              {summary.dropped_files.length > 0 ? (
                <div className="space-y-1.5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Dropped files
                  </p>
                  <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-slate-200">
                    {summary.dropped_files.map((file) => (
                      <li
                        key={file.filename}
                        className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-xs"
                      >
                        <span className="min-w-0 flex-1 truncate font-mono text-slate-700">
                          {file.filename}
                        </span>
                        <span
                          className={cn(
                            "shrink-0 rounded px-1.5 py-0.5 font-medium",
                            file.reason === "unparsable"
                              ? "bg-red-100 text-red-700"
                              : file.reason === "wrong_domain"
                                ? "bg-amber-100 text-amber-700"
                                : "bg-slate-100 text-slate-600"
                          )}
                        >
                          {DROP_REASON_LABEL[file.reason]}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="flex flex-wrap gap-3 pt-1">
                <Button
                  type="button"
                  onClick={() => void handleDownloadZip()}
                  className="gap-2"
                >
                  <Download className="h-4 w-4" />
                  Download cleaned sitemaps (ZIP)
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handleDownloadCsv()}
                  className="gap-2"
                  disabled={summary.duplicate_urls.length === 0}
                >
                  <Download className="h-4 w-4" />
                  Download duplicates report (CSV)
                </Button>
              </div>

              {/* Hand off the cleaned files to the Migration Health Checker with
                  the domain + files pre-filled. Opens in a new tab so these
                  results stay visible. (v1.37 Fix 2) */}
              {migrationHandoffUrl ? (
                <div className="mt-2 rounded-xl border border-indigo-200 bg-indigo-50/70 p-4">
                  <p className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    Cleaning complete — ready for migration?
                  </p>
                  <p className="mt-1 text-sm text-slate-600">
                    Start the Sitemap Migration Health Checker with your{" "}
                    {formatNumber(summary.files_kept)} cleaned file
                    {summary.files_kept === 1 ? "" : "s"} and domain pre-filled.
                  </p>
                  <Button asChild className="mt-3 gap-2">
                    <a
                      href={migrationHandoffUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid="start-migration-handoff"
                    >
                      <MapIcon className="h-4 w-4" />
                      Start Migration Analysis
                      <ArrowRight className="h-4 w-4" />
                    </a>
                  </Button>
                </div>
              ) : null}
            </CardContent>
          </Card>
        ) : null}
      </section>
    </main>
  );
}

function SummaryTile({
  label,
  value,
  suffix,
  display
}: {
  label: string;
  value: number;
  suffix?: string;
  // Optional pre-formatted string (e.g. "3.3%"); falls back to formatNumber.
  display?: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 text-center">
      <p className="text-2xl font-bold text-slate-900">
        {display ?? formatNumber(value)}
      </p>
      <p className="mt-0.5 text-xs text-slate-500">
        {label}
        {suffix ? ` (${suffix})` : ""}
      </p>
    </div>
  );
}
