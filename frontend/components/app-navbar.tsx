"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ExternalLink, Loader2, StopCircle } from "lucide-react";

import {
  cancelSession,
  friendlyApiErrorMessage,
  getRuntimeConfig,
  getSession,
  type SessionStatus
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";

// Terminal states: once reached, there is nothing left to stop.
function isActiveStatus(status: SessionStatus) {
  return (
    status !== "COMPLETE" &&
    status !== "COMPLETED" &&
    status !== "FAILED" &&
    status !== "CANCELLED"
  );
}

// A stoppable session route is /sessions/<id> or /sessions/<id>/results — but
// not the /sessions history list.
function sessionIdFromPathname(pathname: string | null) {
  if (!pathname) {
    return null;
  }

  const match = pathname.match(/^\/sessions\/([^/]+)(?:\/results)?\/?$/);
  const id = match?.[1];

  return id && id !== "" ? id : null;
}

export function AppNavbar() {
  const pathname = usePathname();
  const router = useRouter();
  const sessionId = sessionIdFromPathname(pathname);
  const [isActive, setIsActive] = useState(false);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [cancelError, setCancelError] = useState("");

  useEffect(() => {
    if (!sessionId) {
      setIsActive(false);
      return;
    }

    let isCancelled = false;

    async function pollStatus() {
      try {
        const data = await getSession(sessionId as string);

        if (!isCancelled) {
          setIsActive(isActiveStatus(data.session.status));
        }
      } catch {
        // Ignore poll errors; keep the last known state.
      }
    }

    void pollStatus();
    const interval = window.setInterval(() => void pollStatus(), 3000);

    return () => {
      isCancelled = true;
      window.clearInterval(interval);
    };
  }, [sessionId]);

  async function handleConfirmStop() {
    if (!sessionId || isCancelling) {
      return;
    }

    setIsCancelling(true);
    setCancelError("");

    try {
      await cancelSession(sessionId);
      setIsDialogOpen(false);
      setIsActive(false);
      router.push("/");
    } catch (error) {
      setCancelError(
        friendlyApiErrorMessage(error, "Unable to stop the analysis.")
      );
    } finally {
      setIsCancelling(false);
    }
  }

  const showStop = Boolean(sessionId) && isActive;

  // SEO Desk lives in a separate app on its own port. Its URL now comes from
  // the runtime-config endpoint rather than a NEXT_PUBLIC_* build-time inline,
  // so the same image can point at different environments. Cleaner + Migration
  // are this same app, so they stay relative hrefs (portable) in a new tab.
  const [seoDeskUrl, setSeoDeskUrl] = useState("");

  useEffect(() => {
    let cancelled = false;

    void getRuntimeConfig().then((runtimeConfig) => {
      if (!cancelled) {
        setSeoDeskUrl(runtimeConfig.seoDeskUrl);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);
  const isCleanerActive = pathname === "/cleaner";
  const isMigrationActive =
    pathname === "/" || (pathname?.startsWith("/sessions") ?? false);

  const toolLinkClass = (active: boolean) =>
    `inline-flex h-8 items-center gap-1 rounded-md px-2.5 text-xs font-medium transition-colors ${
      active
        ? "bg-indigo-500/20 text-indigo-200 ring-1 ring-inset ring-indigo-400/50"
        : "text-slate-300 hover:bg-slate-800 hover:text-white"
    }`;

  return (
    <>
      <nav className="sticky top-0 z-50 h-14 border-b border-slate-800 bg-slate-900">
        <div className="mx-auto flex h-full w-full max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <Link href="/" className="flex items-center gap-3">
            <span className="relative flex h-3 w-3">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-500" />
            </span>
            <span className="text-sm font-bold text-white sm:text-base">
              Sitemap Health Checker
            </span>
          </Link>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <a
                href="/cleaner"
                target="_blank"
                rel="noopener noreferrer"
                className={toolLinkClass(isCleanerActive)}
              >
                🧹 Cleaner
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
              <a
                href="/"
                target="_blank"
                rel="noopener noreferrer"
                className={toolLinkClass(isMigrationActive)}
              >
                🗺️ Migration
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
              {seoDeskUrl ? (
                <a
                  href={seoDeskUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={toolLinkClass(false)}
                >
                  📋 SEO Desk
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
              ) : null}
            </div>
            <span className="h-5 w-px bg-slate-700" aria-hidden="true" />
            <Link
              href="/sessions"
              className="text-sm font-medium text-slate-300 transition-colors hover:text-white"
            >
              History
            </Link>
            {showStop ? (
              <button
                type="button"
                onClick={() => {
                  setCancelError("");
                  setIsDialogOpen(true);
                }}
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-red-500/70 px-3 text-sm font-semibold text-red-300 transition-colors hover:bg-red-500/10 hover:text-red-200"
              >
                <StopCircle className="h-4 w-4" aria-hidden="true" />
                Stop Analysis
              </button>
            ) : null}
            <Link
              href="/"
              className="inline-flex h-9 items-center justify-center rounded-lg bg-indigo-500 px-4 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-600"
            >
              New Analysis
            </Link>
          </div>
        </div>
      </nav>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Stop this analysis?</DialogTitle>
            <DialogDescription>
              All progress will be lost and you will need to start again.
            </DialogDescription>
          </DialogHeader>
          {cancelError ? (
            <p className="text-sm text-red-500" role="alert">
              {cancelError}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={isCancelling}
              onClick={() => setIsDialogOpen(false)}
            >
              Keep running
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={isCancelling}
              onClick={() => void handleConfirmStop()}
            >
              {isCancelling ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Stopping
                </>
              ) : (
                "Stop Analysis"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
