"use client";

import { useState } from "react";
import { AlertTriangle, ChevronDown, FileText, Info } from "lucide-react";

import type { UploadRejectedFile } from "@/lib/api";

const VISIBLE_LIMIT = 5;

function rejectionDomainSummary(
  rejections: UploadRejectedFile[],
  baseUrl: string
): string {
  const trimmed = baseUrl.trim();

  if (trimmed) {
    return `These files contain URLs from a different domain than ${trimmed}:`;
  }

  const expectedHost = rejections.find((rejection) => rejection.expected_host)
    ?.expected_host;

  if (expectedHost) {
    return `These files contain URLs from a different domain than ${expectedHost}:`;
  }

  return "These files contain URLs from a different domain than the base URL:";
}

// Amber "mismatch" warning shown after an upload when one or more files carry
// URLs from a domain other than the session base URL. These are not hard errors
// — the files were skipped and the rest were accepted — so the styling is a
// warning (amber), each rejected file is its own readable row (bold filename +
// grey detected host), and long lists collapse to the first few with an
// expander.
export function UploadRejections({
  rejections,
  baseUrl
}: {
  rejections: UploadRejectedFile[];
  baseUrl: string;
}) {
  const [expanded, setExpanded] = useState(false);

  if (rejections.length === 0) {
    return null;
  }

  const visible = expanded ? rejections : rejections.slice(0, VISIBLE_LIMIT);
  const hiddenCount = rejections.length - VISIBLE_LIMIT;

  return (
    <div
      className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
      role="alert"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        <p className="font-semibold">
          Some files were not uploaded ({rejections.length}{" "}
          {rejections.length === 1 ? "file" : "files"})
        </p>
      </div>
      <p className="pl-6 text-amber-800">
        {rejectionDomainSummary(rejections, baseUrl)}
      </p>
      <ul className="ml-6 max-h-56 space-y-1.5 overflow-y-auto rounded-lg border border-amber-200 bg-white/60 p-2">
        {visible.map((rejection, index) => (
          <li
            key={`${rejection.filename}:${index}`}
            className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-md px-2 py-1"
          >
            <span className="flex items-baseline gap-1.5">
              <FileText
                className="h-3.5 w-3.5 shrink-0 self-center text-amber-500"
                aria-hidden="true"
              />
              <span className="font-semibold text-slate-800">
                {rejection.filename}
              </span>
            </span>
            {rejection.detected_host ? (
              <span className="text-xs text-slate-500">
                detected: {rejection.detected_host}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {hiddenCount > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="ml-6 flex items-center gap-1 text-xs font-medium text-amber-700 hover:text-amber-900"
        >
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform ${
              expanded ? "rotate-180" : ""
            }`}
            aria-hidden="true"
          />
          {expanded ? "Show less" : `and ${hiddenCount} more`}
        </button>
      ) : null}
      <div className="ml-6 flex items-start gap-2 rounded-lg border border-amber-200 bg-white/70 px-3 py-2 text-xs text-amber-800">
        <Info
          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500"
          aria-hidden="true"
        />
        <span>
          These sitemaps contain URLs from multiple domains. If this is
          intentional, update the Base URL to match.
        </span>
      </div>
    </div>
  );
}
