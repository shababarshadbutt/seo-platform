"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useEffect, useRef } from "react";
import {
  Plus, Trash2, Pencil, ExternalLink, ChevronLeft, ChevronRight,
  Link2, TrendingUp, Clock, AlertTriangle, Loader2, Users, ChevronDown,
  Search, X as XIcon, Download, CheckCircle2, XCircle, ShieldAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BacklinkRow {
  id: string;
  userId: string;
  userName: string;
  websiteName: string;
  targetUrl: string;
  backlinkUrl: string;
  anchorText: string;
  type: string;
  da: number | null;
  status: "live" | "pending" | "broken" | "removed";
  notes: string;
  sourceSiteId: string;
  sourceSiteUrl: string;
  targetWebsiteId: string;
  approvalStatus: string;
  rejectionReason: string;
  rejectedByName: string;
  createdAt: string;
}

export interface TeamMember {
  id: string;
  name: string;
}

export interface GroupOption {
  id: string;
  name: string;
  memberUserIds: string[];
}

export interface BacklinkSiteOption {
  id: string;
  url: string;
  da: number | null;
  spamScore: number | null;
  niche: string;
  reusable: boolean;
}

export interface AssignedWebsiteOption {
  id: string;
  name: string;
}

interface BacklinksClientProps {
  rows: BacklinkRow[];
  total: number;
  stats: { total: number; live: number; pending: number; broken: number; pendingReview: number };
  page: number;
  pageSize: number;
  isSuperAdmin: boolean;
  isSupervisor: boolean;
  currentUserId: string;
  teamMembers: TeamMember[];
  memberCounts: Record<string, number>;
  selectedTab: string;
  groups: GroupOption[];
  groupCounts: Record<string, number>;
  selectedTeamId: string;
  filters: { type: string; status: string; approvalStatus: string; from: string; to: string };
  backlinkSites: BacklinkSiteOption[];
  assignedWebsites: AssignedWebsiteOption[];
}

const BACKLINK_TYPES = [
  { value: "guest-post", label: "Guest Post" },
  { value: "directory", label: "Business Listing" },
  { value: "forum", label: "Profiles Creation" },
  { value: "social", label: "Social Bookmarks" },
  { value: "article", label: "Web 2.0" },
  { value: "comment", label: "UGC" },
  { value: "press-release", label: "Forum" },
  { value: "other", label: "Other" },
];

const STATUSES = [
  { value: "live", label: "Live" },
  { value: "pending", label: "Pending" },
  { value: "broken", label: "Broken" },
  { value: "removed", label: "Removed" },
];

// ─── Main component ───────────────────────────────────────────────────────────

export function BacklinksClient({
  rows: initialRows,
  total,
  stats,
  page,
  pageSize,
  isSuperAdmin,
  isSupervisor,
  currentUserId,
  teamMembers,
  memberCounts,
  selectedTab,
  groups,
  groupCounts,
  selectedTeamId,
  filters,
  backlinkSites,
  assignedWebsites,
}: BacklinksClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [rows, setRows] = useState(initialRows);
  useEffect(() => { setRows(initialRows); }, [initialRows]);

  const [addOpen, setAddOpen] = useState(false);
  const [editItem, setEditItem] = useState<BacklinkRow | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [rejectRow,   setRejectRow]   = useState<BacklinkRow | null>(null);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [memberDropdownOpen, setMemberDropdownOpen] = useState(false);
  const [memberSearch, setMemberSearch] = useState("");

  const canViewTeam = isSuperAdmin || isSupervisor;
  const totalPages = Math.ceil(total / pageSize);
  const isAllTab = canViewTeam && selectedTab === "" && selectedTeamId === "";
  const isTeamTab = isSuperAdmin && selectedTeamId !== "";
  const selectedGroup = groups.find((g) => g.id === selectedTeamId);
  const totalMemberBacklinks = Object.values(memberCounts).reduce((a, b) => a + b, 0);

  function navigate(params: Record<string, string | undefined>) {
    const p = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(params)) {
      if (v) p.set(k, v); else p.delete(k);
    }
    p.delete("page");
    router.push(`/backlinks?${p.toString()}`);
  }

  function setFilter(key: string, value: string) {
    navigate({ [key]: value || undefined });
  }

  function switchTab(tabValue: string) {
    const p = new URLSearchParams();
    if (tabValue) p.set("tab", tabValue);
    if (filters.type) p.set("type", filters.type);
    if (filters.status) p.set("status", filters.status);
    if (filters.approvalStatus) p.set("approvalStatus", filters.approvalStatus);
    if (filters.from) p.set("from", filters.from);
    if (filters.to) p.set("to", filters.to);
    router.push(`/backlinks?${p.toString()}`);
  }

  function switchTeam(teamId: string) {
    const p = new URLSearchParams();
    if (teamId) p.set("teamId", teamId);
    if (filters.type) p.set("type", filters.type);
    if (filters.status) p.set("status", filters.status);
    if (filters.approvalStatus) p.set("approvalStatus", filters.approvalStatus);
    if (filters.from) p.set("from", filters.from);
    if (filters.to) p.set("to", filters.to);
    router.push(`/backlinks?${p.toString()}`);
  }

  function goToPage(p: number) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("page", String(p));
    router.push(`/backlinks?${params.toString()}`);
  }

  function downloadCSV() {
    const p = new URLSearchParams();
    if (selectedTab)    p.set("tab",    selectedTab);
    if (selectedTeamId) p.set("teamId", selectedTeamId);
    if (filters.type)   p.set("type",   filters.type);
    if (filters.status) p.set("status", filters.status);
    if (filters.from)   p.set("from",   filters.from);
    if (filters.to)     p.set("to",     filters.to);
    window.location.href = `/api/backlinks/export?${p.toString()}`;
  }

  function onAdded(row: BacklinkRow) {
    setRows((prev) => [row, ...prev]);
    setAddOpen(false);
    router.refresh();
  }

  function onEdited(row: BacklinkRow) {
    setRows((prev) => prev.map((r) => (r.id === row.id ? row : r)));
    setEditItem(null);
    router.refresh();
  }

  function onReviewDone(updated: BacklinkRow) {
    setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
    setRejectRow(null);
  }

  async function confirmDelete() {
    if (!deleteId) return;
    setDeleting(true);
    const res = await fetch(`/api/backlinks/${deleteId}`, { method: "DELETE" });
    setDeleting(false);
    if (res.ok) {
      setRows((prev) => prev.filter((r) => r.id !== deleteId));
      setDeleteId(null);
      router.refresh();
    } else {
      alert((await res.json()).error);
    }
  }

  async function approveRow(row: BacklinkRow) {
    if (approvingId) return;
    setApprovingId(row.id);
    try {
      const res = await fetch(`/api/backlinks/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      });
      const data = await res.json();
      if (res.ok) onReviewDone(data);
      else alert(data.error ?? "Approval failed.");
    } catch {
      alert("Network error. Please try again.");
    } finally {
      setApprovingId(null);
    }
  }

  const showMember = canViewTeam && isAllTab;

  return (
    <div className="space-y-5">

      {/* ── Header ── */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold">Backlinks Tracker</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            {isSuperAdmin
              ? `${totalMemberBacklinks} backlinks across ${teamMembers.length} team members`
              : isSupervisor
              ? `Viewing your group's backlinks`
              : "Your backlink history"}
          </p>
        </div>
        <div className="flex gap-2">
          {isSuperAdmin && (
            <Button variant="outline" onClick={downloadCSV}>
              <Download className="h-4 w-4" />
              Download CSV
            </Button>
          )}
          {!isSuperAdmin && (
            <Button onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4" />
              Add Backlink
            </Button>
          )}
        </div>
      </div>

      {/* ── Member selector dropdown (super-admin + supervisor) ── */}
      {canViewTeam && teamMembers.length > 0 && (
        <div className="relative w-72">
          <label className="text-xs text-muted-foreground block mb-1.5 font-medium">Viewing backlinks for</label>

          <button
            type="button"
            onClick={() => { setMemberDropdownOpen((v) => !v); setMemberSearch(""); }}
            className="w-full flex items-center gap-3 h-11 px-3 rounded-xl border border-input bg-card text-sm font-medium shadow-sm hover:bg-muted/40 transition-colors"
          >
            {isAllTab ? (
              <>
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 shrink-0">
                  <Users className="h-4 w-4 text-primary" />
                </div>
                <div className="flex-1 text-left">
                  <span>All Members</span>
                  <span className="ml-2 text-xs text-muted-foreground">({totalMemberBacklinks})</span>
                </div>
              </>
            ) : isTeamTab && selectedGroup ? (
              <>
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-500/15 shrink-0">
                  <Users className="h-4 w-4 text-blue-600" />
                </div>
                <div className="flex-1 text-left">
                  <span>{selectedGroup.name}</span>
                  <span className="ml-2 text-xs text-muted-foreground">({groupCounts[selectedTeamId] ?? 0})</span>
                </div>
              </>
            ) : (
              <>
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold uppercase shrink-0">
                  {teamMembers.find((m) => m.id === selectedTab)?.name[0] ?? "?"}
                </div>
                <div className="flex-1 text-left">
                  <span>{teamMembers.find((m) => m.id === selectedTab)?.name ?? "Unknown"}</span>
                  <span className="ml-2 text-xs text-muted-foreground">({memberCounts[selectedTab] ?? 0})</span>
                </div>
              </>
            )}
            <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform shrink-0", memberDropdownOpen && "rotate-180")} />
          </button>

          {memberDropdownOpen && (
            <div className="absolute z-50 top-full left-0 mt-1.5 w-full rounded-xl border bg-card shadow-lg overflow-hidden">
              <div className="p-2 border-b">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <input
                    autoFocus
                    type="text"
                    placeholder="Search member…"
                    value={memberSearch}
                    onChange={(e) => setMemberSearch(e.target.value)}
                    className="w-full h-8 pl-8 pr-3 rounded-lg border border-input bg-background text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  {memberSearch && (
                    <button onClick={() => setMemberSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2">
                      <XIcon className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                    </button>
                  )}
                </div>
              </div>

              <div className="max-h-60 overflow-y-auto py-1">
                {!memberSearch && (
                  <button
                    onClick={() => { switchTab(""); setMemberDropdownOpen(false); }}
                    className={cn(
                      "w-full flex items-center gap-3 px-3 py-2 text-sm transition-colors hover:bg-muted/50",
                      isAllTab && "bg-primary/5 text-primary font-medium"
                    )}
                  >
                    <div className="flex h-7 w-7 items-center justify-center rounded-full bg-muted shrink-0">
                      <Users className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                    <span className="flex-1 text-left">All Members</span>
                    <span className="text-xs text-muted-foreground">{totalMemberBacklinks}</span>
                  </button>
                )}

                {!memberSearch && isSuperAdmin && groups.length > 0 && (
                  <>
                    <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide border-t mt-1">
                      Teams
                    </div>
                    {groups.map((g) => (
                      <button
                        key={g.id}
                        onClick={() => { switchTeam(g.id); setMemberDropdownOpen(false); }}
                        className={cn(
                          "w-full flex items-center gap-3 px-3 py-2 text-sm transition-colors hover:bg-muted/50",
                          selectedTeamId === g.id && "bg-blue-500/5 text-blue-700 font-medium"
                        )}
                      >
                        <div className={cn(
                          "flex h-7 w-7 items-center justify-center rounded-full shrink-0",
                          selectedTeamId === g.id ? "bg-blue-500/15" : "bg-muted"
                        )}>
                          <Users className={cn("h-3.5 w-3.5", selectedTeamId === g.id ? "text-blue-600" : "text-muted-foreground")} />
                        </div>
                        <span className="flex-1 text-left">{g.name}</span>
                        <span className="text-xs text-muted-foreground">{groupCounts[g.id] ?? 0}</span>
                      </button>
                    ))}
                    <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide border-t mt-1">
                      Members
                    </div>
                  </>
                )}

                {teamMembers
                  .filter((m) => m.name.toLowerCase().includes(memberSearch.toLowerCase()))
                  .map((member) => {
                    const isSelected = selectedTab === member.id;
                    const count = memberCounts[member.id] ?? 0;
                    return (
                      <button
                        key={member.id}
                        onClick={() => { switchTab(member.id); setMemberDropdownOpen(false); setMemberSearch(""); }}
                        className={cn(
                          "w-full flex items-center gap-3 px-3 py-2 text-sm transition-colors hover:bg-muted/50",
                          isSelected && "bg-primary/5 text-primary font-medium"
                        )}
                      >
                        <div className={cn(
                          "flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold uppercase shrink-0",
                          isSelected ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"
                        )}>
                          {member.name[0]}
                        </div>
                        <span className="flex-1 text-left">{member.name}</span>
                        <span className="text-xs text-muted-foreground">{count}</span>
                      </button>
                    );
                  })}

                {memberSearch && teamMembers.filter((m) => m.name.toLowerCase().includes(memberSearch.toLowerCase())).length === 0 && (
                  <p className="text-xs text-muted-foreground text-center py-4">No members found</p>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Stats cards ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <StatCard icon={Link2}       label="Total"          value={stats.total}         color="blue" />
        <StatCard icon={TrendingUp}  label="Live"           value={stats.live}          color="green" />
        <StatCard icon={Clock}       label="Pending"        value={stats.pending}       color="yellow" />
        <StatCard icon={AlertTriangle} label="Broken"       value={stats.broken}        color="red" />
        <StatCard icon={ShieldAlert} label="Pending Review" value={stats.pendingReview} color="orange" />
      </div>

      {/* ── Filters ── */}
      <div className="flex flex-wrap items-center gap-3 p-3 rounded-xl border bg-card">
        <select
          className="h-9 rounded-lg border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={filters.type}
          onChange={(e) => setFilter("type", e.target.value)}
        >
          <option value="">All Types</option>
          {BACKLINK_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>

        <select
          className="h-9 rounded-lg border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={filters.status}
          onChange={(e) => setFilter("status", e.target.value)}
        >
          <option value="">All Statuses</option>
          {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>

        <select
          className="h-9 rounded-lg border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={filters.approvalStatus}
          onChange={(e) => setFilter("approvalStatus", e.target.value)}
        >
          <option value="">All Reviews</option>
          <option value="pending">Pending Review</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>

        <div className="flex items-center gap-2 ml-auto">
          <span className="text-xs text-muted-foreground">Date:</span>
          <input
            type="date"
            value={filters.from}
            onChange={(e) => setFilter("from", e.target.value)}
            className="h-8 rounded-lg border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <span className="text-xs text-muted-foreground">–</span>
          <input
            type="date"
            value={filters.to}
            onChange={(e) => setFilter("to", e.target.value)}
            className="h-8 rounded-lg border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          {(filters.type || filters.status || filters.approvalStatus || filters.from || filters.to) && (
            <button
              onClick={() => navigate({ type: undefined, status: undefined, approvalStatus: undefined, from: undefined, to: undefined })}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors underline"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* ── Table ── */}
      {rows.length === 0 ? (
        <div className="rounded-xl border bg-card flex flex-col items-center justify-center py-16 gap-3">
          <Link2 className="h-10 w-10 text-muted-foreground/20" />
          <p className="text-sm font-medium text-muted-foreground">
            {isSuperAdmin
              ? isAllTab ? "No backlinks added yet by any team member" : "This member has no backlinks yet"
              : "You haven't added any backlinks yet"}
          </p>
          {!isSuperAdmin && (
            <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
              <Plus className="h-3.5 w-3.5" />Add your first backlink
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide whitespace-nowrap">Website</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide whitespace-nowrap">Backlink URL</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide whitespace-nowrap">Source Site</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide whitespace-nowrap">Type</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide whitespace-nowrap">Review</th>
                    {showMember && (
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide whitespace-nowrap">
                        <div className="flex items-center gap-1"><Users className="h-3 w-3" />Member</div>
                      </th>
                    )}
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide whitespace-nowrap">Date</th>
                    <th className="px-4 py-3 w-24" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((row) => (
                    <BacklinkTableRow
                      key={row.id}
                      row={row}
                      isSuperAdmin={isSuperAdmin}
                      isSupervisor={isSupervisor}
                      currentUserId={currentUserId}
                      showMember={showMember}
                      approving={approvingId === row.id}
                      onEdit={() => setEditItem(row)}
                      onDelete={() => setDeleteId(row.id)}
                      onApprove={() => approveRow(row)}
                      onReject={() => setRejectRow(row)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
              <span>{(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total} backlinks</span>
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

      {/* ── Add dialog ── */}
      {!isSuperAdmin && (
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader><DialogTitle>Add Backlink</DialogTitle></DialogHeader>
            <AddBacklinkForm
              backlinkSites={backlinkSites}
              assignedWebsites={assignedWebsites}
              onSuccess={onAdded}
              onCancel={() => setAddOpen(false)}
            />
          </DialogContent>
        </Dialog>
      )}

      {/* ── Edit dialog ── */}
      {!isSuperAdmin && (
        <Dialog open={!!editItem} onOpenChange={(o) => { if (!o) setEditItem(null); }}>
          <DialogContent className="max-w-lg">
            <DialogHeader><DialogTitle>Edit Backlink</DialogTitle></DialogHeader>
            {editItem && (
              <EditBacklinkForm initial={editItem} onSuccess={onEdited} onCancel={() => setEditItem(null)} />
            )}
          </DialogContent>
        </Dialog>
      )}

      {/* ── Reject reason dialog ── */}
      <Dialog open={!!rejectRow} onOpenChange={(o) => { if (!o) setRejectRow(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Reject Backlink</DialogTitle></DialogHeader>
          {rejectRow && (
            <RejectForm
              row={rejectRow}
              onDone={onReviewDone}
              onCancel={() => setRejectRow(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* ── Delete confirm ── */}
      {!isSuperAdmin && (
        <Dialog open={!!deleteId} onOpenChange={(o) => { if (!o) setDeleteId(null); }}>
          <DialogContent className="max-w-sm">
            <DialogHeader><DialogTitle>Delete Backlink</DialogTitle></DialogHeader>
            <p className="text-sm text-muted-foreground">Are you sure? This cannot be undone.</p>
            <div className="flex gap-2 justify-end pt-2">
              <Button variant="outline" onClick={() => setDeleteId(null)} disabled={deleting}>Cancel</Button>
              <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
                {deleting && <Loader2 className="h-4 w-4 animate-spin" />}Delete
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// ─── Stat card ────────────────────────────────────────────────────────────────

function StatCard({ icon: Icon, label, value, color }: {
  icon: React.ElementType; label: string; value: number;
  color: "blue" | "green" | "yellow" | "red" | "orange";
}) {
  const colors = {
    blue:   "bg-blue-50 text-blue-600",
    green:  "bg-green-50 text-green-600",
    yellow: "bg-yellow-50 text-yellow-600",
    red:    "bg-red-50 text-red-500",
    orange: "bg-orange-50 text-orange-500",
  };
  return (
    <div className="rounded-xl border bg-card p-4 flex items-center gap-3">
      <div className={cn("rounded-lg p-2.5 shrink-0", colors[color])}>
        <Icon className="h-4 w-4" />
      </div>
      <div>
        <p className="text-2xl font-bold leading-none">{value}</p>
        <p className="text-xs text-muted-foreground mt-1">{label}</p>
      </div>
    </div>
  );
}

// ─── Table row ────────────────────────────────────────────────────────────────

function BacklinkTableRow({
  row, isSuperAdmin, isSupervisor, currentUserId, showMember, approving,
  onEdit, onDelete, onApprove, onReject,
}: {
  row: BacklinkRow;
  isSuperAdmin: boolean;
  isSupervisor: boolean;
  currentUserId: string;
  showMember: boolean;
  approving: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const canModify = !isSuperAdmin && row.userId === currentUserId;
  // allow review on any row not yet finalized (empty = old backlink, or "pending")
  const canReview = (isSuperAdmin || isSupervisor) && row.approvalStatus !== "approved" && row.approvalStatus !== "rejected";

  return (
    <tr className="hover:bg-muted/30 transition-colors group">
      <td className="px-4 py-3 font-medium max-w-[150px]">
        <span className="truncate block" title={row.websiteName}>{row.websiteName}</span>
      </td>
      <td className="px-4 py-3 max-w-[220px]">
        <a href={row.backlinkUrl} target="_blank" rel="noopener noreferrer"
          className="flex items-center gap-1 text-blue-600 hover:underline text-xs" title={row.backlinkUrl}>
          <span className="truncate">{stripProtocol(row.backlinkUrl)}</span>
          <ExternalLink className="h-3 w-3 shrink-0" />
        </a>
      </td>
      <td className="px-4 py-3 max-w-[160px]">
        {row.sourceSiteUrl ? (
          <span className="text-xs text-muted-foreground truncate block" title={row.sourceSiteUrl}>
            {stripProtocol(row.sourceSiteUrl)}
          </span>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        )}
      </td>
      <td className="px-4 py-3"><TypeBadge type={row.type} /></td>
      <td className="px-4 py-3 max-w-[180px]">
        <ApprovalBadge
          status={row.approvalStatus}
          reason={row.rejectionReason}
          rejectedByName={row.rejectedByName}
        />
      </td>
      {showMember && (
        <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
          <div className="flex items-center gap-1.5">
            <div className="h-5 w-5 rounded-full bg-muted flex items-center justify-center text-[10px] font-bold uppercase shrink-0">
              {row.userName[0]}
            </div>
            {row.userName.split(" ")[0]}
          </div>
        </td>
      )}
      <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
        {new Date(row.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit", timeZone: "Asia/Karachi" })}
      </td>
      <td className="px-4 py-3">
        <div className="flex gap-1 justify-end">
          {canReview && (
            <>
              <Button
                type="button"
                variant="ghost" size="sm"
                className="h-7 w-7 p-0 text-green-600 hover:text-green-700 hover:bg-green-50"
                onClick={onApprove}
                disabled={approving}
                title="Approve"
              >
                {approving
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <CheckCircle2 className="h-4 w-4" />
                }
              </Button>
              <Button
                type="button"
                variant="ghost" size="sm"
                className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                onClick={onReject}
                disabled={approving}
                title="Reject"
              >
                <XCircle className="h-4 w-4" />
              </Button>
            </>
          )}
          {canModify && (
            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onEdit}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive hover:text-destructive" onClick={onDelete}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

// ─── Reject form ──────────────────────────────────────────────────────────────

function RejectForm({ row, onDone, onCancel }: {
  row: BacklinkRow;
  onDone: (updated: BacklinkRow) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(""); setLoading(true);
    const res = await fetch(`/api/backlinks/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reject", rejectionReason: reason }),
    });
    setLoading(false);
    if (!res.ok) { setError((await res.json()).error ?? "Something went wrong."); return; }
    onDone(await res.json());
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 mt-1">
      <p className="text-sm text-muted-foreground">
        Rejecting backlink to <span className="font-medium text-foreground">{row.websiteName}</span>.
        The member will be able to resubmit.
      </p>
      <div className="space-y-1.5">
        <Label>Reason (optional)</Label>
        <textarea
          className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-none"
          rows={3}
          placeholder="Explain why this backlink is being rejected…"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2 justify-end">
        <Button type="button" variant="outline" onClick={onCancel} disabled={loading}>Cancel</Button>
        <Button type="submit" variant="destructive" disabled={loading}>
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          Reject
        </Button>
      </div>
    </form>
  );
}

// ─── Add form (new workflow) ──────────────────────────────────────────────────

function todayPKT() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Karachi" });
}

function AddBacklinkForm({ backlinkSites, assignedWebsites, onSuccess, onCancel }: {
  backlinkSites: BacklinkSiteOption[];
  assignedWebsites: AssignedWebsiteOption[];
  onSuccess: (row: BacklinkRow) => void;
  onCancel: () => void;
}) {
  const [targetWebsiteId, setTargetWebsiteId] = useState(assignedWebsites[0]?.id ?? "");
  const [websiteNameFree, setWebsiteNameFree] = useState("");
  const [sourceSiteId, setSourceSiteId] = useState("");
  const [backlinkUrl, setBacklinkUrl] = useState("");
  const [type, setType] = useState("other");
  const [date, setDate] = useState(todayPKT());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [usedSiteIds, setUsedSiteIds] = useState<string[]>([]);
  const [siteDropdownOpen, setSiteDropdownOpen] = useState(false);
  const [siteSearch, setSiteSearch] = useState("");
  const siteDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (siteDropdownRef.current && !siteDropdownRef.current.contains(e.target as Node)) {
        setSiteDropdownOpen(false);
      }
    }
    if (siteDropdownOpen) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [siteDropdownOpen]);

  const hasAssigned = assignedWebsites.length > 0;
  const selectedWebsite = assignedWebsites.find((w) => w.id === targetWebsiteId);
  const websiteName = hasAssigned ? (selectedWebsite?.name ?? "") : websiteNameFree;
  const selectedSource = backlinkSites.find((s) => s.id === sourceSiteId);
  const availableSites = backlinkSites.filter((s) => !usedSiteIds.includes(s.id));
  const filteredSites = availableSites.filter((s) =>
    s.url.toLowerCase().includes(siteSearch.toLowerCase())
  );

  useEffect(() => {
    if (!targetWebsiteId) { setUsedSiteIds([]); setSourceSiteId(""); return; }
    fetch(`/api/backlinks/used-sources?targetWebsiteId=${targetWebsiteId}`)
      .then((r) => r.json())
      .then((d) => {
        const ids: string[] = d.usedSiteIds ?? [];
        setUsedSiteIds(ids);
        // clear selected source if it became unavailable
        if (ids.includes(sourceSiteId)) setSourceSiteId("");
      })
      .catch(() => {});
  }, [targetWebsiteId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!websiteName.trim()) { setError("Please select a target website."); return; }
    if (!sourceSiteId) { setError("Please select a source site."); return; }
    if (!backlinkUrl.trim()) { setError("Backlink URL is required."); return; }
    setError(""); setLoading(true);

    const res = await fetch("/api/backlinks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetWebsiteId: hasAssigned ? targetWebsiteId : "",
        websiteName: websiteName.trim(),
        sourceSiteId,
        backlinkUrl: backlinkUrl.trim(),
        type,
        date,
      }),
    });
    setLoading(false);
    if (!res.ok) { setError((await res.json()).error ?? "Something went wrong."); return; }
    onSuccess(await res.json());
  }

  const selectClass = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Target website */}
      <div className="space-y-1.5">
        <Label>Target Website <span className="text-destructive">*</span></Label>
        {hasAssigned ? (
          <select
            className={selectClass}
            value={targetWebsiteId}
            onChange={(e) => setTargetWebsiteId(e.target.value)}
            required
          >
            <option value="">Select website…</option>
            {assignedWebsites.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
        ) : (
          <Input
            placeholder="e.g. Aviation Axis"
            value={websiteNameFree}
            onChange={(e) => setWebsiteNameFree(e.target.value)}
            required
          />
        )}
      </div>

      {/* Source site */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label>Source Site <span className="text-destructive">*</span></Label>
          {usedSiteIds.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {usedSiteIds.length} already used for this website
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <a
            href={selectedSource ? (selectedSource.url.startsWith("http") ? selectedSource.url : `https://${selectedSource.url}`) : undefined}
            target="_blank"
            rel="noopener noreferrer"
            tabIndex={selectedSource ? 0 : -1}
            aria-disabled={!selectedSource}
            className={cn(
              "h-10 w-10 shrink-0 flex items-center justify-center rounded-md border border-input transition-colors",
              selectedSource
                ? "bg-background text-blue-600 hover:bg-blue-50 hover:border-blue-300 cursor-pointer"
                : "bg-muted text-muted-foreground/40 pointer-events-none"
            )}
            title={selectedSource ? `Open ${selectedSource.url}` : "Select a source site first"}
            onClick={(e) => { if (!selectedSource) e.preventDefault(); }}
          >
            <ExternalLink className="h-4 w-4" />
          </a>

          {/* Custom searchable dropdown */}
          <div ref={siteDropdownRef} className="relative flex-1">
            <button
              type="button"
              onClick={() => { setSiteDropdownOpen((v) => !v); setSiteSearch(""); }}
              className={cn(
                selectClass,
                "flex items-center justify-between text-left",
                !sourceSiteId && "text-muted-foreground"
              )}
            >
              <span className="truncate">
                {selectedSource
                  ? `${selectedSource.url}${selectedSource.da != null ? ` (DA ${selectedSource.da})` : ""}`
                  : "Select source site…"}
              </span>
              <ChevronDown className={cn("h-4 w-4 shrink-0 ml-2 text-muted-foreground transition-transform", siteDropdownOpen && "rotate-180")} />
            </button>

            {siteDropdownOpen && (
              <div className="absolute z-50 top-full left-0 mt-1 w-full rounded-lg border bg-card shadow-lg overflow-hidden">
                <div className="p-2 border-b">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <input
                      autoFocus
                      type="text"
                      placeholder="Search sites…"
                      value={siteSearch}
                      onChange={(e) => setSiteSearch(e.target.value)}
                      className="w-full h-8 pl-8 pr-3 rounded-md border border-input bg-background text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    {siteSearch && (
                      <button type="button" onClick={() => setSiteSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2">
                        <XIcon className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                      </button>
                    )}
                  </div>
                </div>
                <div className="max-h-52 overflow-y-auto py-1">
                  {filteredSites.length === 0 ? (
                    <p className="text-xs text-muted-foreground text-center py-4">No sites found</p>
                  ) : (
                    filteredSites.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => { setSourceSiteId(s.id); setSiteDropdownOpen(false); setSiteSearch(""); }}
                        className={cn(
                          "w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-muted/50 transition-colors text-left",
                          sourceSiteId === s.id && "bg-primary/5 text-primary font-medium"
                        )}
                      >
                        <span className="truncate">{s.url}</span>
                        {s.da != null && (
                          <span className="text-xs text-muted-foreground shrink-0 ml-2">DA {s.da}</span>
                        )}
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
        {availableSites.length === 0 && targetWebsiteId && (
          <p className="text-xs text-yellow-600">All available source sites have already been used for this website.</p>
        )}
        {selectedSource && (
          <p className="text-xs text-muted-foreground">
            {selectedSource.niche && <span className="mr-2">{selectedSource.niche}</span>}
            {selectedSource.spamScore != null && <span>Spam: {selectedSource.spamScore}%</span>}
          </p>
        )}
      </div>

      {/* Backlink URL */}
      <div className="space-y-1.5">
        <Label>Backlink URL <span className="text-destructive">*</span></Label>
        <Input
          type="url"
          placeholder="https://example.com/page-with-backlink"
          value={backlinkUrl}
          onChange={(e) => setBacklinkUrl(e.target.value)}
          required
        />
        <p className="text-xs text-muted-foreground">The specific page on the source site that contains your backlink.</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>Type</Label>
          <select className={selectClass} value={type} onChange={(e) => setType(e.target.value)}>
            {BACKLINK_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label>Date</Label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex gap-2 justify-end pt-1">
        <Button type="button" variant="outline" onClick={onCancel} disabled={loading}>Cancel</Button>
        <Button type="submit" disabled={loading || !websiteName.trim() || !sourceSiteId || !backlinkUrl.trim()}>
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          Submit for Review
        </Button>
      </div>
    </form>
  );
}

// ─── Edit form (single) ───────────────────────────────────────────────────────

function EditBacklinkForm({ initial, onSuccess, onCancel }: {
  initial: BacklinkRow;
  onSuccess: (row: BacklinkRow) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({
    websiteName: initial.websiteName,
    backlinkUrl: initial.backlinkUrl,
    type: initial.type,
    status: initial.status,
    date: initial.createdAt.slice(0, 10),
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  function set(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(""); setLoading(true);
    const res = await fetch(`/api/backlinks/${initial.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    setLoading(false);
    if (!res.ok) { setError((await res.json()).error ?? "Something went wrong."); return; }
    onSuccess(await res.json());
  }

  const selectClass = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <Label>Website Name <span className="text-destructive">*</span></Label>
        <Input value={form.websiteName} onChange={(e) => set("websiteName", e.target.value)} required />
      </div>
      <div className="space-y-1.5">
        <Label>Backlink URL <span className="text-destructive">*</span></Label>
        <Input type="url" value={form.backlinkUrl} onChange={(e) => set("backlinkUrl", e.target.value)} required />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>Type</Label>
          <select className={selectClass} value={form.type} onChange={(e) => set("type", e.target.value)}>
            {BACKLINK_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label>Status</Label>
          <select className={selectClass} value={form.status} onChange={(e) => set("status", e.target.value)}>
            {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label>Date</Label>
        <input
          type="date"
          value={form.date}
          onChange={(e) => set("date", e.target.value)}
          required
          className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2 justify-end pt-1">
        <Button type="button" variant="outline" onClick={onCancel} disabled={loading}>Cancel</Button>
        <Button type="submit" disabled={loading}>
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          Save Changes
        </Button>
      </div>
    </form>
  );
}

// ─── Badges & helpers ─────────────────────────────────────────────────────────

function ApprovalBadge({ status, reason, rejectedByName }: {
  status: string;
  reason?: string;
  rejectedByName?: string;
}) {
  if (status === "approved") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border bg-green-50 text-green-700 border-green-200">
        <CheckCircle2 className="h-3 w-3" />Approved
      </span>
    );
  }
  if (status === "rejected") {
    return (
      <div className="space-y-1">
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border bg-red-50 text-red-700 border-red-200">
          <XCircle className="h-3 w-3" />Rejected
        </span>
        {rejectedByName && (
          <p className="text-xs text-muted-foreground">by {rejectedByName}</p>
        )}
        {reason && (
          <p className="text-xs text-red-600 leading-snug">{reason}</p>
        )}
      </div>
    );
  }
  if (status === "pending") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border bg-orange-50 text-orange-600 border-orange-200">
        <Clock className="h-3 w-3" />Pending Review
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border bg-muted text-muted-foreground border-border">
      <Clock className="h-3 w-3" />Not Reviewed
    </span>
  );
}

function TypeBadge({ type }: { type: string }) {
  const label = BACKLINK_TYPES.find((t) => t.value === type)?.label ?? type;
  return <Badge variant="secondary" className="text-xs whitespace-nowrap">{label}</Badge>;
}

function stripProtocol(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/, "");
}
