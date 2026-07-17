"use client";

import { useState, useCallback, useEffect, useTransition } from "react";
import { ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Search } from "lucide-react";

type UrlRow = {
  id: string;
  url: string;
  discoveredAt: string | null;
  gscStatus: string;
  gscSubmittedAt: string | null;
  gscError: string | null;
  bingStatus: string;
  bingSubmittedAt: string | null;
  bingError: string | null;
};

type Sitemap = {
  url: string;
  discoveredAt: string | null;
};

type Pagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

type WebsiteInfo = {
  id: string;
  name: string;
  url: string;
  sitemapCount: number;
  sitemaps: Sitemap[];
};

type Props = {
  websiteId: string;
  initialWebsite: WebsiteInfo;
  initialUrls: UrlRow[];
  initialPagination: Pagination;
};

const STATUS_OPTIONS = [
  { value: "all",       label: "All" },
  { value: "pending",   label: "Pending" },
  { value: "submitted", label: "Submitted" },
  { value: "failed",    label: "Failed" },
];

function statusBadge(status: string) {
  if (status === "submitted") return <span className="inline-block rounded-full bg-green-100 text-green-800 px-2 py-0.5 text-xs font-medium">Submitted</span>;
  if (status === "failed")    return <span className="inline-block rounded-full bg-red-100 text-red-800 px-2 py-0.5 text-xs font-medium">Failed</span>;
  return <span className="inline-block rounded-full bg-yellow-100 text-yellow-800 px-2 py-0.5 text-xs font-medium">Pending</span>;
}

function fmt(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export function QueueClient({ websiteId, initialWebsite, initialUrls, initialPagination }: Props) {
  const [urls, setUrls]               = useState<UrlRow[]>(initialUrls);
  const [pagination, setPagination]   = useState<Pagination>(initialPagination);
  const [gscFilter, setGscFilter]     = useState("all");
  const [bingFilter, setBingFilter]   = useState("all");
  const [search, setSearch]           = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [sitemapsOpen, setSitemapsOpen] = useState(false);
  const [isPending, startTransition]  = useTransition();

  const fetchUrls = useCallback(
    (page: number, gsc: string, bing: string, q: string) => {
      startTransition(async () => {
        const params = new URLSearchParams({
          page: String(page),
          gscStatus: gsc,
          bingStatus: bing,
          search: q,
        });
        const res = await fetch(`/api/indexing-queue/${websiteId}?${params}`);
        if (!res.ok) return;
        const data = await res.json();
        setUrls(data.urls);
        setPagination(data.pagination);
      });
    },
    [websiteId]
  );

  // Re-fetch when filters change (reset to page 1)
  useEffect(() => {
    fetchUrls(1, gscFilter, bingFilter, search);
  }, [gscFilter, bingFilter, search, fetchUrls]);

  function handleSearch() {
    setSearch(searchInput);
  }

  return (
    <div className="space-y-6">
      {/* Sitemaps collapsible */}
      <div className="rounded-lg border border-gray-200 overflow-hidden">
        <button
          onClick={() => setSitemapsOpen((o) => !o)}
          className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors text-sm font-medium text-gray-700"
        >
          <span>Sitemaps ({initialWebsite.sitemapCount})</span>
          {sitemapsOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        {sitemapsOpen && (
          <div className="divide-y divide-gray-100 max-h-60 overflow-y-auto">
            {initialWebsite.sitemaps.length === 0 ? (
              <p className="px-4 py-3 text-sm text-gray-500">No sitemaps saved yet.</p>
            ) : (
              initialWebsite.sitemaps.map((s, i) => (
                <div key={i} className="flex items-center justify-between px-4 py-2 text-xs">
                  <a href={s.url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline truncate max-w-lg">
                    {s.url}
                  </a>
                  <span className="text-gray-400 ml-4 shrink-0">{fmt(s.discoveredAt)}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Search */}
        <div className="flex items-center gap-1 border border-gray-300 rounded-md px-2 py-1.5 bg-white text-sm">
          <Search className="h-3.5 w-3.5 text-gray-400" />
          <input
            type="text"
            placeholder="Search URL..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            className="outline-none w-56 text-sm placeholder:text-gray-400"
          />
          <button onClick={handleSearch} className="text-xs text-blue-600 hover:text-blue-800 ml-1">Go</button>
        </div>

        {/* GSC filter */}
        <div className="flex items-center gap-1.5 text-sm">
          <span className="text-gray-500 text-xs font-medium">GSC:</span>
          {STATUS_OPTIONS.map((o) => (
            <button
              key={o.value}
              onClick={() => setGscFilter(o.value)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                gscFilter === o.value
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>

        {/* Bing filter */}
        <div className="flex items-center gap-1.5 text-sm">
          <span className="text-gray-500 text-xs font-medium">Bing:</span>
          {STATUS_OPTIONS.map((o) => (
            <button
              key={o.value}
              onClick={() => setBingFilter(o.value)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                bingFilter === o.value
                  ? "bg-orange-500 text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>

        <span className="ml-auto text-xs text-gray-400">
          {pagination.total.toLocaleString()} URL(s)
        </span>
      </div>

      {/* URL table */}
      <div className={`rounded-lg border border-gray-200 overflow-hidden transition-opacity ${isPending ? "opacity-50" : ""}`}>
        {urls.length === 0 ? (
          <p className="px-4 py-6 text-sm text-gray-500 text-center">No URLs match the current filters.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">URL</th>
                <th className="text-center px-3 py-3 font-medium text-gray-600 whitespace-nowrap">Discovered</th>
                <th className="text-center px-3 py-3 font-medium text-gray-600">GSC</th>
                <th className="text-center px-3 py-3 font-medium text-gray-600 whitespace-nowrap">GSC Date</th>
                <th className="text-center px-3 py-3 font-medium text-gray-600">Bing</th>
                <th className="text-center px-3 py-3 font-medium text-gray-600 whitespace-nowrap">Bing Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {urls.map((row) => (
                <tr key={row.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-2.5">
                    <a
                      href={row.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-600 hover:underline truncate block max-w-lg text-xs"
                    >
                      {row.url}
                    </a>
                    {row.gscError && (
                      <p className="text-xs text-red-500 mt-0.5 truncate max-w-lg">GSC: {row.gscError}</p>
                    )}
                    {row.bingError && (
                      <p className="text-xs text-red-500 mt-0.5 truncate max-w-lg">Bing: {row.bingError}</p>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-center text-xs text-gray-500 whitespace-nowrap">{fmt(row.discoveredAt)}</td>
                  <td className="px-3 py-2.5 text-center">{statusBadge(row.gscStatus)}</td>
                  <td className="px-3 py-2.5 text-center text-xs text-gray-500 whitespace-nowrap">{fmt(row.gscSubmittedAt)}</td>
                  <td className="px-3 py-2.5 text-center">{statusBadge(row.bingStatus)}</td>
                  <td className="px-3 py-2.5 text-center text-xs text-gray-500 whitespace-nowrap">{fmt(row.bingSubmittedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-500 text-xs">
            Page {pagination.page} of {pagination.totalPages} ({pagination.total.toLocaleString()} total)
          </span>
          <div className="flex items-center gap-2">
            <button
              disabled={pagination.page <= 1}
              onClick={() => fetchUrls(pagination.page - 1, gscFilter, bingFilter, search)}
              className="p-1.5 rounded-md border border-gray-300 disabled:opacity-40 hover:bg-gray-50 transition-colors"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              disabled={pagination.page >= pagination.totalPages}
              onClick={() => fetchUrls(pagination.page + 1, gscFilter, bingFilter, search)}
              className="p-1.5 rounded-md border border-gray-300 disabled:opacity-40 hover:bg-gray-50 transition-colors"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
