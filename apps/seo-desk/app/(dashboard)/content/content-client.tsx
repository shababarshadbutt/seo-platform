"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Plus, Trash2, Pencil, ExternalLink, Loader2,
  ChevronDown, CheckCircle, Clock, AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TaskType = "landing-request" | "blog-request" | "landing-update" | "blog-publish";
export type TaskStatus = "pending" | "in-progress" | "done";

export interface ContentTaskRow {
  id: string;
  userId: string;
  userName: string;
  taskType: TaskType;
  websiteName: string;
  websiteUrl: string;
  status: TaskStatus;
  date: string;
  docsLink: string;
  pageUrls: string[];
  sheetLink: string;
  blogTopics: string[];
  updatedPageLinks: string[];
  publishedBlogLinks: string[];
}

interface ContentClientProps {
  tasks: ContentTaskRow[];
  taskType: TaskType;
  pageTitle: string;
  viewerRole: string;
  members: { id: string; name: string }[];
}

const PKT = "Asia/Karachi";

const STATUS_OPTIONS: { value: TaskStatus; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "in-progress", label: "In Progress" },
  { value: "done", label: "Done" },
];

function StatusBadge({ status }: { status: TaskStatus }) {
  if (status === "done") return (
    <Badge className="gap-1 bg-green-500/15 text-green-700 border-green-400/30 hover:bg-green-500/15">
      <CheckCircle className="h-3 w-3" /> Done
    </Badge>
  );
  if (status === "in-progress") return (
    <Badge className="gap-1 bg-blue-500/15 text-blue-700 border-blue-400/30 hover:bg-blue-500/15">
      <Clock className="h-3 w-3" /> In Progress
    </Badge>
  );
  return (
    <Badge className="gap-1 bg-yellow-500/15 text-yellow-700 border-yellow-400/30 hover:bg-yellow-500/15">
      <AlertCircle className="h-3 w-3" /> Pending
    </Badge>
  );
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    timeZone: PKT, day: "numeric", month: "short", year: "numeric",
  });
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ContentClient({
  tasks: initial, taskType, pageTitle, viewerRole, members,
}: ContentClientProps) {
  const router = useRouter();
  const [tasks, setTasks] = useState(initial);
  useEffect(() => { setTasks(initial); }, [initial]);

  const [addOpen, setAddOpen] = useState(false);
  const [editItem, setEditItem] = useState<ContentTaskRow | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Filters
  const [filterMember, setFilterMember] = useState("");
  const [filterFrom,   setFilterFrom]   = useState("");
  const [filterTo,     setFilterTo]     = useState("");
  const [filterStatus, setFilterStatus] = useState("");

  const canEdit = viewerRole !== "super-admin";
  const canSeeMembers = viewerRole !== "admin";

  const filtered = tasks.filter((t) => {
    if (filterMember && t.userId !== filterMember) return false;
    if (filterStatus && t.status !== filterStatus)  return false;
    if (filterFrom   && t.date.slice(0, 10) < filterFrom) return false;
    if (filterTo     && t.date.slice(0, 10) > filterTo)   return false;
    return true;
  });

  const isFiltering = !!(filterMember || filterStatus || filterFrom || filterTo);

  async function onSaved(task: ContentTaskRow, isNew: boolean) {
    if (isNew) {
      setTasks((prev) => [task, ...prev]);
    } else {
      setTasks((prev) => prev.map((t) => (t.id === task.id ? task : t)));
    }
    setAddOpen(false);
    setEditItem(null);
    router.refresh();
  }

  async function confirmDelete() {
    if (!deleteId) return;
    setDeleting(true);
    const res = await fetch(`/api/content-tasks/${deleteId}`, { method: "DELETE" });
    setDeleting(false);
    if (res.ok) {
      setTasks((prev) => prev.filter((t) => t.id !== deleteId));
      setDeleteId(null);
      router.refresh();
    }
  }

  const pending    = filtered.filter((t) => t.status === "pending").length;
  const inProgress = filtered.filter((t) => t.status === "in-progress").length;
  const done       = filtered.filter((t) => t.status === "done").length;

  return (
    <div className="space-y-5">

      {/* ── Header ── */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold">{pageTitle}</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            {isFiltering
              ? `${filtered.length} of ${tasks.length} record${tasks.length !== 1 ? "s" : ""}`
              : `${tasks.length} record${tasks.length !== 1 ? "s" : ""}`}
          </p>
        </div>
        {canEdit && (
          <Button onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" />
            Add Record
          </Button>
        )}
      </div>

      {/* ── Filters ── */}
      <div className="flex flex-wrap gap-3 items-end">
        {canSeeMembers && members.length > 0 && (
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Member</Label>
            <select
              value={filterMember}
              onChange={(e) => setFilterMember(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">All members</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>
        )}
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Status</Label>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">All statuses</option>
            <option value="pending">Pending</option>
            <option value="in-progress">In Progress</option>
            <option value="done">Done</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">From</Label>
          <input type="date" value={filterFrom} onChange={(e) => setFilterFrom(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">To</Label>
          <input type="date" value={filterTo} onChange={(e) => setFilterTo(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        </div>
        {isFiltering && (
          <Button size="sm" variant="outline"
            onClick={() => { setFilterMember(""); setFilterStatus(""); setFilterFrom(""); setFilterTo(""); }}>
            Clear
          </Button>
        )}
      </div>

      {/* ── Stats ── */}
      {filtered.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: "Pending",     count: pending,    color: "text-yellow-700 bg-yellow-50 border-yellow-200" },
            { label: "In Progress", count: inProgress, color: "text-blue-700 bg-blue-50 border-blue-200" },
            { label: "Done",        count: done,       color: "text-green-700 bg-green-50 border-green-200" },
          ].map((s) => (
            <div key={s.label} className={cn("rounded-lg border p-3 text-center", s.color)}>
              <p className="text-2xl font-bold">{s.count}</p>
              <p className="text-xs font-medium mt-0.5">{s.label}</p>
            </div>
          ))}
        </div>
      )}

      {/* ── Table ── */}
      <TaskTable
        rows={filtered}
        taskType={taskType}
        canEdit={canEdit}
        viewerRole={viewerRole}
        onEdit={setEditItem}
        onDelete={setDeleteId}
      />

      {/* ── Add dialog ── */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add Record — {pageTitle}</DialogTitle>
          </DialogHeader>
          <TaskForm
            taskType={taskType}
            onSaved={(t) => onSaved(t, true)}
            onCancel={() => setAddOpen(false)}
          />
        </DialogContent>
      </Dialog>

      {/* ── Edit dialog ── */}
      <Dialog open={!!editItem} onOpenChange={(o) => { if (!o) setEditItem(null); }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Record</DialogTitle>
          </DialogHeader>
          {editItem && (
            <TaskForm
              key={editItem.id}
              taskType={taskType}
              existing={editItem}
              onSaved={(t) => onSaved(t, false)}
              onCancel={() => setEditItem(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* ── Delete confirm ── */}
      <Dialog open={!!deleteId} onOpenChange={(o) => { if (!o) setDeleteId(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete this record?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">This action cannot be undone.</p>
          <div className="flex gap-2 justify-end mt-2">
            <Button variant="outline" onClick={() => setDeleteId(null)}>Cancel</Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting && <Loader2 className="h-4 w-4 animate-spin" />}
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Task Table ───────────────────────────────────────────────────────────────

function TaskTable({
  rows, taskType, canEdit, viewerRole, onEdit, onDelete,
}: {
  rows: ContentTaskRow[];
  taskType: TaskType;
  canEdit: boolean;
  viewerRole: string;
  onEdit: (r: ContentTaskRow) => void;
  onDelete: (id: string) => void;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-12 text-center">
        <p className="text-muted-foreground text-sm">No records yet. Click &quot;Add Record&quot; to get started.</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              {viewerRole !== "admin" && (
                <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">Member</th>
              )}
              <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">Website</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">Date</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">Status</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">Links</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row) => (
              <TaskRow
                key={row.id}
                row={row}
                taskType={taskType}
                canEdit={canEdit}
                showMember={viewerRole !== "admin"}
                onEdit={onEdit}
                onDelete={onDelete}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TaskRow({
  row, taskType, canEdit, showMember, onEdit, onDelete,
}: {
  row: ContentTaskRow;
  taskType: TaskType;
  canEdit: boolean;
  showMember: boolean;
  onEdit: (r: ContentTaskRow) => void;
  onDelete: (id: string) => void;
}) {
  const [linksOpen, setLinksOpen] = useState(false);

  const links =
    taskType === "landing-request" ? row.pageUrls :
    taskType === "landing-update" ? row.updatedPageLinks :
    taskType === "blog-publish" ? row.publishedBlogLinks : [];

  const mainLink =
    taskType === "landing-request" ? row.docsLink :
    taskType === "blog-request" ? row.sheetLink : null;

  const mainLinkLabel =
    taskType === "landing-request" ? "Docs" :
    taskType === "blog-request" ? "Sheet" : null;

  return (
    <tr className="hover:bg-muted/30 transition-colors">
      {showMember && (
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-xs font-bold uppercase shrink-0">
              {row.userName[0]}
            </div>
            <span className="text-sm font-medium">{row.userName}</span>
          </div>
        </td>
      )}
      <td className="px-4 py-3">
        <div>
          <p className="font-medium">{row.websiteName}</p>
          <a href={row.websiteUrl} target="_blank" rel="noopener noreferrer"
            className="text-xs text-muted-foreground hover:text-primary flex items-center gap-0.5 w-fit">
            {row.websiteUrl.replace(/^https?:\/\//, "").slice(0, 35)}
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </td>
      <td className="px-4 py-3 text-muted-foreground text-xs whitespace-nowrap">
        {formatDate(row.date)}
      </td>
      <td className="px-4 py-3">
        <StatusBadge status={row.status} />
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-col gap-1">
          {mainLink && mainLinkLabel && (
            <a href={mainLink} target="_blank" rel="noopener noreferrer"
              className="text-xs text-primary hover:underline flex items-center gap-1">
              {mainLinkLabel}
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
          {links.length > 0 && (
            <>
              <button
                onClick={() => setLinksOpen((v) => !v)}
                className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
              >
                {links.length} page{links.length !== 1 ? "s" : ""}
                <ChevronDown className={cn("h-3 w-3 transition-transform", linksOpen && "rotate-180")} />
              </button>
              {linksOpen && (
                <div className="space-y-0.5 mt-1">
                  {links.map((url, i) => (
                    <a key={i} href={url} target="_blank" rel="noopener noreferrer"
                      className="block text-xs text-primary hover:underline truncate max-w-[200px]">
                      {url.replace(/^https?:\/\//, "")}
                    </a>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </td>
      <td className="px-4 py-3">
        {canEdit && (
          <div className="flex gap-1 justify-end">
            <Button variant="ghost" size="sm" onClick={() => onEdit(row)}>
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onDelete(row.id)}>
              <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          </div>
        )}
      </td>
    </tr>
  );
}

// ─── Task Form ────────────────────────────────────────────────────────────────

function TaskForm({
  taskType, existing, onSaved, onCancel,
}: {
  taskType: TaskType;
  existing?: ContentTaskRow;
  onSaved: (task: ContentTaskRow) => void;
  onCancel: () => void;
}) {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: PKT });

  const [websiteName, setWebsiteName] = useState(existing?.websiteName ?? "");
  const [websiteUrl, setWebsiteUrl] = useState(existing?.websiteUrl ?? "");
  const [status, setStatus] = useState<TaskStatus>(existing?.status ?? "pending");
  const [date, setDate] = useState(existing ? existing.date.slice(0, 10) : today);
  const [docsLink, setDocsLink] = useState(existing?.docsLink ?? "");
  const [pageUrlsText, setPageUrlsText] = useState((existing?.pageUrls ?? []).join("\n"));
  const [sheetLink, setSheetLink] = useState(existing?.sheetLink ?? "");
  const [blogTopicsText, setBlogTopicsText] = useState((existing?.blogTopics ?? []).join("\n"));
  const [updatedLinksText, setUpdatedLinksText] = useState((existing?.updatedPageLinks ?? []).join("\n"));
  const [publishedLinksText, setPublishedLinksText] = useState((existing?.publishedBlogLinks ?? []).join("\n"));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  function parseLines(text: string): string[] {
    return text.split("\n").map((l) => l.trim()).filter(Boolean);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(""); setLoading(true);

    const body = {
      taskType,
      websiteName,
      websiteUrl,
      status,
      date,
      docsLink,
      pageUrls: parseLines(pageUrlsText),
      sheetLink,
      blogTopics: parseLines(blogTopicsText),
      updatedPageLinks: parseLines(updatedLinksText),
      publishedBlogLinks: parseLines(publishedLinksText),
    };

    const url = existing ? `/api/content-tasks/${existing.id}` : "/api/content-tasks";
    const method = existing ? "PATCH" : "POST";

    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    setLoading(false);

    if (!res.ok) {
      setError((await res.json()).error ?? "Something went wrong.");
      return;
    }

    const resData = await res.json();

    // Both POST and PATCH now return the full record from DB — use as source of truth.
    const saved: ContentTaskRow = {
      id: resData.id,
      userId: resData.userId ?? existing?.userId ?? "",
      userName: resData.userName ?? existing?.userName ?? "",
      taskType: resData.taskType ?? taskType,
      websiteName: resData.websiteName ?? websiteName,
      websiteUrl: resData.websiteUrl ?? websiteUrl,
      status: resData.status ?? status,
      date: resData.date ?? new Date(date).toISOString(),
      docsLink: resData.docsLink ?? docsLink,
      pageUrls: resData.pageUrls ?? parseLines(pageUrlsText),
      sheetLink: resData.sheetLink ?? sheetLink,
      blogTopics: resData.blogTopics ?? parseLines(blogTopicsText),
      updatedPageLinks: resData.updatedPageLinks ?? parseLines(updatedLinksText),
      publishedBlogLinks: resData.publishedBlogLinks ?? parseLines(publishedLinksText),
    };

    onSaved(saved);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>Website Name</Label>
          <Input placeholder="e.g. Example.com" value={websiteName}
            onChange={(e) => setWebsiteName(e.target.value)} required />
        </div>
        <div className="space-y-1.5">
          <Label>Website URL</Label>
          <Input placeholder="https://example.com" value={websiteUrl}
            onChange={(e) => setWebsiteUrl(e.target.value)} required />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>Date</Label>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </div>
        <div className="space-y-1.5">
          <Label>Status</Label>
          <select
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={status}
            onChange={(e) => setStatus(e.target.value as TaskStatus)}
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>
      </div>

      {taskType === "landing-request" && (
        <>
          <div className="space-y-1.5">
            <Label>Docs Link</Label>
            <Input placeholder="https://docs.google.com/..." value={docsLink}
              onChange={(e) => setDocsLink(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Pages URLs <span className="text-muted-foreground text-xs">(one per line)</span></Label>
            <Textarea
              placeholder={"https://example.com/page-1\nhttps://example.com/page-2"}
              className="min-h-[100px] font-mono text-xs"
              value={pageUrlsText}
              onChange={(e) => setPageUrlsText(e.target.value)}
            />
          </div>
        </>
      )}

      {taskType === "blog-request" && (
        <>
          <div className="space-y-1.5">
            <Label>Sheet Link</Label>
            <Input placeholder="https://docs.google.com/spreadsheets/..." value={sheetLink}
              onChange={(e) => setSheetLink(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Blog Topics <span className="text-muted-foreground text-xs">(one per line)</span></Label>
            <Textarea
              placeholder={"How to improve SEO rankings\nBest practices for content marketing\n..."}
              className="min-h-[100px] text-xs"
              value={blogTopicsText}
              onChange={(e) => setBlogTopicsText(e.target.value)}
            />
          </div>
        </>
      )}

      {taskType === "landing-update" && (
        <div className="space-y-1.5">
          <Label>Updated Pages Links <span className="text-muted-foreground text-xs">(one per line)</span></Label>
          <Textarea
            placeholder={"https://example.com/page-1\nhttps://example.com/page-2"}
            className="min-h-[100px] font-mono text-xs"
            value={updatedLinksText}
            onChange={(e) => setUpdatedLinksText(e.target.value)}
          />
        </div>
      )}

      {taskType === "blog-publish" && (
        <div className="space-y-1.5">
          <Label>Published Blogs Links <span className="text-muted-foreground text-xs">(one per line)</span></Label>
          <Textarea
            placeholder={"https://example.com/blog-1\nhttps://example.com/blog-2"}
            className="min-h-[100px] font-mono text-xs"
            value={publishedLinksText}
            onChange={(e) => setPublishedLinksText(e.target.value)}
          />
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex gap-2 justify-end pt-1">
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={loading}>
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          {existing ? "Save Changes" : "Add Record"}
        </Button>
      </div>
    </form>
  );
}
