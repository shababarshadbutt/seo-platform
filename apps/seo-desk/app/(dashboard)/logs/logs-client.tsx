"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import {
  CheckCircle, XCircle, Loader2, Eye,
  ChevronLeft, ChevronRight, CalendarDays,
  TrendingUp, Activity, AlertCircle, Users, ChevronDown, Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LogRow {
  id: string;
  scriptName: string;
  scriptSlug: string;
  userName: string;
  userEmail: string;
  status: "running" | "success" | "error";
  exitCode: number | null;
  startedAt: string;
  durationMs: number | null;
  output: string;
  isAutomated: boolean;
  websiteId: string | null;
  websiteName: string | null;
}

export interface UserTab {
  id: string;
  name: string;
  email: string;
  role: string;
}

export interface GroupTab {
  id: string;
  name: string;
  memberUserIds: string[];
}

interface LogsPageClientProps {
  users: UserTab[];
  selectedUserId: string;
  selectedTeamId: string;
  groups: GroupTab[];
  logs: LogRow[];
  stats: { total: number; success: number; error: number };
  from: string;
  to: string;
  page: number;
  total: number;
  pageSize: number;
  currentAdminId: string;
  viewerRole: string;
  runType: "all" | "manual" | "automated";
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function toDateStr(d: Date) {
  return d.toISOString().split("T")[0];
}

const PRESETS = [
  {
    label: "Today",
    getRange() { const t = toDateStr(new Date()); return { from: t, to: t }; },
  },
  {
    label: "Yesterday",
    getRange() {
      const d = new Date(); d.setDate(d.getDate() - 1); const s = toDateStr(d);
      return { from: s, to: s };
    },
  },
  {
    label: "Last 7 Days",
    getRange() {
      const d = new Date(); d.setDate(d.getDate() - 6);
      return { from: toDateStr(d), to: toDateStr(new Date()) };
    },
  },
  {
    label: "This Month",
    getRange() {
      const d = new Date(); d.setDate(1);
      return { from: toDateStr(d), to: toDateStr(new Date()) };
    },
  },
];

function detectPreset(from: string, to: string): string | null {
  for (const p of PRESETS) {
    const r = p.getRange();
    if (r.from === from && r.to === to) return p.label;
  }
  return null;
}

function formatDisplayDate(from: string, to: string) {
  if (from === to) {
    const today = toDateStr(new Date());
    const yd = new Date(); yd.setDate(yd.getDate() - 1);
    if (from === today) return "Today";
    if (from === toDateStr(yd)) return "Yesterday";
    return new Date(from).toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" });
  }
  const f = new Date(from).toLocaleDateString([], { day: "numeric", month: "short" });
  const t = new Date(to).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
  return `${f} – ${t}`;
}

// ─── Main component ───────────────────────────────────────────────────────────

export function LogsPageClient({
  users,
  selectedUserId,
  selectedTeamId,
  groups,
  logs,
  stats,
  from,
  to,
  page,
  total,
  pageSize,
  currentAdminId,
  viewerRole,
  runType,
}: LogsPageClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [showCustom, setShowCustom] = useState(detectPreset(from, to) === null);
  const [customFrom, setCustomFrom] = useState(from);
  const [customTo, setCustomTo] = useState(to);

  const activePreset = detectPreset(from, to);
  const totalPages = Math.ceil(total / pageSize);
  const selectedUser = users.find((u) => u.id === selectedUserId);
  const selectedTeam = groups.find((g) => g.id === selectedTeamId);
  const successRate = stats.total > 0 ? Math.round((stats.success / stats.total) * 100) : null;
  const isOverall = selectedUserId === "" && selectedTeamId === "";

  function navigate(params: Record<string, string | undefined>) {
    const p = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") p.set(k, v);
      else p.delete(k);
    }
    p.delete("page");
    router.push(`/logs?${p.toString()}`);
  }

  function applyPreset(preset: (typeof PRESETS)[number]) {
    const { from, to } = preset.getRange();
    setShowCustom(false);
    navigate({ from, to });
  }

  function applyCustom() {
    if (!customFrom || !customTo) return;
    navigate({ from: customFrom, to: customTo });
  }

  function goToPage(p: number) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("page", String(p));
    router.push(`/logs?${params.toString()}`);
  }

  return (
    <div className="space-y-5">

      {/* ── Page header ── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold">Execution Logs</h2>
          <p className="text-sm text-muted-foreground mt-0.5 flex items-center gap-1.5">
            <CalendarDays className="h-3.5 w-3.5" />
            {formatDisplayDate(from, to)}
            <span className="text-muted-foreground/40">·</span>
            {viewerRole === "admin"
              ? "My activity"
              : isOverall
              ? viewerRole === "sub-lead" ? "My group" : "All team members"
              : selectedTeam
              ? selectedTeam.name
              : selectedUser?.name}
          </p>
        </div>

        {/* Filters — hidden for regular users */}
        {viewerRole !== "admin" && (
          <div className="flex items-end gap-2 flex-wrap">
            {/* Team dropdown — super-admin only */}
            {viewerRole === "super-admin" && groups.length > 0 && (
              <div className="relative">
                <label className="text-xs text-muted-foreground block mb-1">Filter by team</label>
                <div className="relative">
                  <select
                    className="h-10 pl-9 pr-8 rounded-xl border border-input bg-card text-sm font-medium appearance-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring shadow-sm cursor-pointer min-w-[170px]"
                    value={selectedTeamId}
                    onChange={(e) => navigate({ teamId: e.target.value || undefined, userId: undefined })}
                  >
                    <option value="">All Teams</option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>{g.name}</option>
                    ))}
                  </select>
                  <Activity className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                </div>
              </div>
            )}

            {/* User dropdown */}
            <div className="relative">
              <label className="text-xs text-muted-foreground block mb-1">Viewing activity for</label>
              <div className="relative">
                <select
                  className="h-10 pl-9 pr-8 rounded-xl border border-input bg-card text-sm font-medium appearance-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring shadow-sm cursor-pointer min-w-[200px]"
                  value={selectedUserId}
                  onChange={(e) => navigate({ userId: e.target.value || undefined, teamId: undefined })}
                >
                  <option value="">{viewerRole === "sub-lead" ? "My Group (Overall)" : "All Members (Overall)"}</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}{u.id === currentAdminId ? " (you)" : ""}
                    </option>
                  ))}
                </select>
                <Users className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Filters bar ── */}
      <div className="flex flex-wrap items-center gap-2 p-3 rounded-xl border bg-card">
        <span className="text-xs font-medium text-muted-foreground mr-1">Period:</span>
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            onClick={() => applyPreset(preset)}
            className={cn(
              "px-3 py-1.5 rounded-full text-xs font-medium transition-all border",
              activePreset === preset.label && !showCustom
                ? "bg-primary text-primary-foreground border-primary shadow-sm"
                : "bg-background border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground"
            )}
          >
            {preset.label}
          </button>
        ))}
        <button
          onClick={() => setShowCustom((v) => !v)}
          className={cn(
            "px-3 py-1.5 rounded-full text-xs font-medium transition-all border",
            showCustom
              ? "bg-primary text-primary-foreground border-primary shadow-sm"
              : "bg-background border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground"
          )}
        >
          Custom Range
        </button>

        {/* Run type filter — super-admin only */}
        {viewerRole === "super-admin" && (
          <>
            <div className="h-4 w-px bg-border mx-1" />
            {(["all", "manual", "automated"] as const).map((rt) => (
              <button
                key={rt}
                onClick={() => navigate({ runType: rt === "all" ? undefined : rt })}
                className={cn(
                  "px-3 py-1.5 rounded-full text-xs font-medium transition-all border flex items-center gap-1",
                  runType === rt || (rt === "all" && runType === "all")
                    ? "bg-primary text-primary-foreground border-primary shadow-sm"
                    : "bg-background border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground"
                )}
              >
                {rt === "automated" && <Zap className="h-3 w-3" />}
                {rt.charAt(0).toUpperCase() + rt.slice(1)}
              </button>
            ))}
          </>
        )}

        {/* Custom inputs inline */}
        {showCustom && (
          <>
            <div className="h-4 w-px bg-border mx-1" />
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="h-8 rounded-lg border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <span className="text-xs text-muted-foreground">to</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="h-8 rounded-lg border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <Button size="sm" className="h-8 text-xs" onClick={applyCustom} disabled={!customFrom || !customTo}>
              Apply
            </Button>
          </>
        )}
      </div>

      {/* ── Stats cards ── */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl border bg-card p-4 flex items-center gap-3">
          <div className="rounded-lg bg-blue-50 dark:bg-blue-950 p-2.5 shrink-0">
            <Activity className="h-4 w-4 text-blue-600" />
          </div>
          <div>
            <p className="text-2xl font-bold leading-none">{stats.total}</p>
            <p className="text-xs text-muted-foreground mt-1">Total Runs</p>
          </div>
        </div>
        <div className="rounded-xl border bg-card p-4 flex items-center gap-3">
          <div className="rounded-lg bg-green-50 dark:bg-green-950 p-2.5 shrink-0">
            <TrendingUp className="h-4 w-4 text-green-600" />
          </div>
          <div>
            <p className="text-2xl font-bold leading-none text-green-600">{stats.success}</p>
            <p className="text-xs text-muted-foreground mt-1">
              Successful{successRate !== null ? ` · ${successRate}%` : ""}
            </p>
          </div>
        </div>
        <div className="rounded-xl border bg-card p-4 flex items-center gap-3">
          <div className="rounded-lg bg-red-50 dark:bg-red-950 p-2.5 shrink-0">
            <AlertCircle className="h-4 w-4 text-red-500" />
          </div>
          <div>
            <p className="text-2xl font-bold leading-none text-red-500">{stats.error}</p>
            <p className="text-xs text-muted-foreground mt-1">
              Failed{successRate !== null ? ` · ${100 - successRate}%` : ""}
            </p>
          </div>
        </div>
      </div>

      {/* ── Logs table ── */}
      {logs.length === 0 ? (
        <div className="rounded-xl border bg-card flex flex-col items-center justify-center py-16 text-center gap-2">
          <CalendarDays className="h-8 w-8 text-muted-foreground/20" />
          <p className="text-sm font-medium text-muted-foreground">No runs found</p>
          <p className="text-xs text-muted-foreground/60">Try selecting a different date range or team member</p>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">Script</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">Member</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">Time</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">Duration</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {logs.map((log) => (
                  <LogTableRow key={log.id} log={log} />
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
              <span>{(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total} runs</span>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="sm" className="h-7 w-7 p-0" onClick={() => goToPage(page - 1)} disabled={page <= 1}>
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
                <span className="px-2">{page} / {totalPages}</span>
                <Button variant="outline" size="sm" className="h-7 w-7 p-0" onClick={() => goToPage(page + 1)} disabled={page >= totalPages}>
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Table row ────────────────────────────────────────────────────────────────

function LogTableRow({ log }: { log: LogRow }) {
  return (
    <tr className="hover:bg-muted/30 transition-colors group">
      <td className="px-4 py-3 font-medium">
        <div>
          {log.scriptName}
          {log.isAutomated && log.websiteName && (
            <p className="text-xs text-muted-foreground font-normal mt-0.5">{log.websiteName}</p>
          )}
        </div>
      </td>
      <td className="px-4 py-3 text-muted-foreground text-xs">
        {log.isAutomated ? (
          <div className="inline-flex items-center gap-1.5 rounded-full bg-violet-50 border border-violet-200 px-2.5 py-1 text-xs font-medium text-violet-600">
            <Zap className="h-3 w-3" />
            Automated
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <div className="h-5 w-5 rounded-full bg-muted flex items-center justify-center text-[10px] font-bold uppercase shrink-0">
              {log.userName[0]}
            </div>
            {log.userName}
          </div>
        )}
      </td>
      <td className="px-4 py-3"><StatusBadge status={log.status} /></td>
      <td className="px-4 py-3 text-muted-foreground text-xs">{formatDateTime(log.startedAt)}</td>
      <td className="px-4 py-3 text-muted-foreground text-xs">{log.durationMs != null ? formatDuration(log.durationMs) : "—"}</td>
      <td className="px-4 py-3">
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs opacity-0 group-hover:opacity-100 transition-opacity">
              <Eye className="h-3.5 w-3.5 mr-1" />Output
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-3xl">
            <DialogHeader>
              <DialogTitle>{log.scriptName}</DialogTitle>
              <div className="flex items-center gap-3 pt-1 text-sm text-muted-foreground flex-wrap">
                <StatusBadge status={log.status} />
                {log.isAutomated ? (
                  <span className="inline-flex items-center gap-1 text-violet-600"><Zap className="h-3 w-3" />Automated{log.websiteName ? ` · ${log.websiteName}` : ""}</span>
                ) : (
                  <span>{log.userName}</span>
                )}
                <span>{new Date(log.startedAt).toLocaleString("en-PK", { timeZone: PKT, hour12: true })}</span>
                {log.durationMs != null && <span>{formatDuration(log.durationMs)}</span>}
              </div>
            </DialogHeader>
            <div className="rounded-lg bg-gray-950 p-4 font-mono text-xs text-gray-200 overflow-y-auto max-h-[420px]">
              {log.output ? (
                log.output.split("\n").map((line, i) => (
                  <div key={i} className={cn(
                    "leading-5",
                    line.startsWith("[ERROR]") && "text-red-400",
                    line.startsWith("[WARN]") && "text-yellow-400",
                    line.startsWith("[DONE]") && "text-green-400",
                    line.startsWith("[INFO]") && "text-gray-300"
                  )}>{line}</div>
                ))
              ) : (
                <span className="text-gray-500">No output recorded.</span>
              )}
            </div>
          </DialogContent>
        </Dialog>
      </td>
    </tr>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: LogRow["status"] }) {
  if (status === "success")
    return <Badge variant="success" className="gap-1"><CheckCircle className="h-3 w-3" />Success</Badge>;
  if (status === "error")
    return <Badge variant="destructive" className="gap-1"><XCircle className="h-3 w-3" />Error</Badge>;
  return <Badge variant="warning" className="gap-1"><Loader2 className="h-3 w-3 animate-spin" />Running</Badge>;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

const PKT = "Asia/Karachi";

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const todayStr = now.toLocaleDateString("en-PK", { timeZone: PKT });
  const dStr = d.toLocaleDateString("en-PK", { timeZone: PKT });
  const yd = new Date(now); yd.setDate(yd.getDate() - 1);
  const ydStr = yd.toLocaleDateString("en-PK", { timeZone: PKT });
  const time = d.toLocaleTimeString("en-PK", { timeZone: PKT, hour: "2-digit", minute: "2-digit", hour12: true });
  if (dStr === todayStr) return `Today, ${time}`;
  if (dStr === ydStr) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString("en-PK", { timeZone: PKT, day: "numeric", month: "short" })}, ${time}`;
}
