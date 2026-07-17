"use client";

import { useState } from "react";

export function CleanupButton() {
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [result, setResult] = useState<{ queueDeleted: number; websitesDisabled: number } | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  async function handleCleanup() {
    setStatus("loading");
    try {
      const res = await fetch("/api/admin/cleanup", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed");
      setResult(data);
      setStatus("done");
    } catch (e) {
      console.error(e);
      setStatus("error");
    }
  }

  if (status === "done" && result) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5">
        <p className="font-semibold text-emerald-700">Cleanup complete</p>
        <p className="text-sm text-emerald-600 mt-1">
          {result.queueDeleted.toLocaleString()} queue URLs deleted &middot; {result.websitesDisabled} websites disabled
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-red-200 bg-red-50 p-5 space-y-4">
      <div>
        <p className="font-semibold text-red-700">Danger Zone</p>
        <p className="text-sm text-red-600 mt-1">
          All indexing queue entries will be <strong>permanently deleted</strong> and automation will be <strong>disabled on all websites</strong>.
          This action cannot be undone.
        </p>
      </div>

      {!confirmed ? (
        <button
          onClick={() => setConfirmed(true)}
          className="rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-100 transition-colors"
        >
          Clear Queue + Disable All Automation
        </button>
      ) : (
        <div className="space-y-3">
          <p className="text-sm font-semibold text-red-700">Are you sure? This cannot be undone.</p>
          <div className="flex gap-3">
            <button
              onClick={handleCleanup}
              disabled={status === "loading"}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
            >
              {status === "loading" ? "Running..." : "Yes, delete everything"}
            </button>
            <button
              onClick={() => setConfirmed(false)}
              className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
          </div>
          {status === "error" && (
            <p className="text-sm text-red-600">Something went wrong — check the terminal for details.</p>
          )}
        </div>
      )}
    </div>
  );
}
