"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Plus, Pencil, Trash2, Loader2, Users, Globe, ExternalLink, UserPlus, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WebsiteRow {
  id: string;
  name: string;
  url: string;
  assignedTo: { userId: string; userName: string }[];
  createdAt: string;
  automationEnabled:     boolean;
  automationStartDate:   string | null;
  gscServiceAccountName: string;
  bingApiKey:            string;
  robotsTxtUrl:          string;
  sitemapCount:          number;
}

export interface MemberOption {
  id: string;
  name: string;
}

interface Props {
  websites:            WebsiteRow[];
  members:             MemberOption[];
  viewerRole:          string;
  currentUserId:       string;
  serviceAccountNames: string[];
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export function WebsitesClient({ websites: initial, members, viewerRole, serviceAccountNames }: Props) {
  const router = useRouter();
  const [websites, setWebsites]       = useState(initial);
  const [addOpen,    setAddOpen]       = useState(false);
  const [editItem,   setEditItem]      = useState<WebsiteRow | null>(null);
  const [deleteId,   setDeleteId]      = useState<string | null>(null);
  const [deleting,   setDeleting]      = useState(false);
  const [assignItem, setAssignItem]    = useState<WebsiteRow | null>(null);
  const [autoItem,   setAutoItem]      = useState<WebsiteRow | null>(null);

  const isSuperAdmin = viewerRole === "super-admin";
  const canFilter    = viewerRole === "super-admin" || viewerRole === "sub-lead";
  const [filterMember, setFilterMember] = useState("");

  const filtered = filterMember
    ? websites.filter((w) => w.assignedTo.some((a) => a.userId === filterMember))
    : websites;

  function onAdded(w: WebsiteRow) {
    setWebsites((prev) => [w, ...prev].sort((a, b) => a.name.localeCompare(b.name)));
    setAddOpen(false);
    router.refresh();
  }

  function onEdited(w: WebsiteRow) {
    setWebsites((prev) => prev.map((x) => (x.id === w.id ? w : x)));
    setEditItem(null);
    router.refresh();
  }

  function onAssigned(w: WebsiteRow) {
    setWebsites((prev) => prev.map((x) => (x.id === w.id ? w : x)));
    setAssignItem(null);
    router.refresh();
  }

  function onAutomationSaved(updated: Partial<WebsiteRow> & { id: string }) {
    setWebsites((prev) =>
      prev.map((x) => (x.id === updated.id ? { ...x, ...updated } : x))
    );
    setAutoItem(null);
    router.refresh();
  }

  async function confirmDelete() {
    if (!deleteId) return;
    setDeleting(true);
    const res = await fetch(`/api/websites/${deleteId}`, { method: "DELETE" });
    setDeleting(false);
    if (res.ok) {
      setWebsites((prev) => prev.filter((w) => w.id !== deleteId));
      setDeleteId(null);
      router.refresh();
    } else {
      alert((await res.json()).error);
    }
  }

  return (
    <div className="space-y-5">

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold">Websites</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            {isSuperAdmin
              ? `${filtered.length} of ${websites.length} website${websites.length !== 1 ? "s" : ""}`
              : `${filtered.length} website${filtered.length !== 1 ? "s" : ""} assigned to you`}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          {canFilter && members.length > 0 && (
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground whitespace-nowrap">Filter by member:</Label>
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
              {filterMember && (
                <button onClick={() => setFilterMember("")} className="text-xs text-muted-foreground hover:text-foreground underline">
                  Clear
                </button>
              )}
            </div>
          )}
          {isSuperAdmin && (
            <Button onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4" />
              Add Website
            </Button>
          )}
        </div>
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <div className="rounded-lg border bg-card p-12 text-center">
          <Globe className="h-8 w-8 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">
            {websites.length === 0
              ? isSuperAdmin ? "No websites added yet." : "No websites assigned to you yet."
              : "No websites match the selected filter."}
          </p>
        </div>
      ) : (
        <div className="rounded-lg border bg-card shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">Website</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">URL</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">Assigned Members</th>
                {isSuperAdmin && <th className="px-4 py-3 w-36" />}
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map((w) => (
                <tr key={w.id} className="hover:bg-muted/20 transition-colors group">
                  <td className="px-4 py-3 font-medium">
                    <div className="flex items-center gap-2">
                      {w.name}
                      {w.automationEnabled && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-600 border border-violet-200">
                          <Zap className="h-3 w-3" />
                          Auto
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {w.url ? (
                      <a href={w.url} target="_blank" rel="noopener noreferrer"
                        className="flex items-center gap-1 text-blue-600 hover:underline text-xs max-w-[220px]">
                        <span className="truncate">{w.url.replace(/^https?:\/\/(www\.)?/, "")}</span>
                        <ExternalLink className="h-3 w-3 shrink-0" />
                      </a>
                    ) : (
                      <span className="text-xs text-muted-foreground/50">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {w.assignedTo.length === 0 ? (
                      <span className="text-xs text-muted-foreground/50">Unassigned</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {w.assignedTo.map((a) => (
                          <span key={a.userId}
                            className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium">
                            {a.userName}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  {isSuperAdmin && (
                    <td className="px-4 py-3">
                      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity justify-end">
                        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs gap-1 text-violet-600 hover:text-violet-700 hover:bg-violet-50"
                          onClick={() => setAutoItem(w)}>
                          <Zap className="h-3.5 w-3.5" />
                          Automation
                        </Button>
                        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs gap-1"
                          onClick={() => setAssignItem(w)}>
                          <UserPlus className="h-3.5 w-3.5" />
                          Assign
                        </Button>
                        <Button variant="ghost" size="sm" className="h-7 w-7 p-0"
                          onClick={() => setEditItem(w)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                          onClick={() => setDeleteId(w.id)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Add Website</DialogTitle></DialogHeader>
          <WebsiteForm onSaved={onAdded} onCancel={() => setAddOpen(false)} />
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editItem} onOpenChange={(o) => { if (!o) setEditItem(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Edit Website</DialogTitle></DialogHeader>
          {editItem && (
            <WebsiteForm existing={editItem} onSaved={onEdited} onCancel={() => setEditItem(null)} />
          )}
        </DialogContent>
      </Dialog>

      {/* Assign dialog */}
      <Dialog open={!!assignItem} onOpenChange={(o) => { if (!o) setAssignItem(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="h-4 w-4" />
              Assign Members — {assignItem?.name}
            </DialogTitle>
          </DialogHeader>
          {assignItem && (
            <AssignForm
              website={assignItem}
              members={members}
              onSaved={onAssigned}
              onCancel={() => setAssignItem(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Automation dialog */}
      <Dialog open={!!autoItem} onOpenChange={(o) => { if (!o) setAutoItem(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-violet-600" />
              Automation Settings — {autoItem?.name}
            </DialogTitle>
          </DialogHeader>
          {autoItem && (
            <AutomationForm
              website={autoItem}
              serviceAccountNames={serviceAccountNames}
              onSaved={onAutomationSaved}
              onCancel={() => setAutoItem(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={!!deleteId} onOpenChange={(o) => { if (!o) setDeleteId(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Delete website?</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">This will permanently delete the website and all its assignments.</p>
          <div className="flex gap-2 justify-end mt-2">
            <Button variant="outline" onClick={() => setDeleteId(null)} disabled={deleting}>Cancel</Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting && <Loader2 className="h-4 w-4 animate-spin" />} Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Website Form (Add / Edit) ────────────────────────────────────────────────

function WebsiteForm({ existing, onSaved, onCancel }: {
  existing?: WebsiteRow;
  onSaved: (w: WebsiteRow) => void;
  onCancel: () => void;
}) {
  const [name,    setName]    = useState(existing?.name ?? "");
  const [url,     setUrl]     = useState(existing?.url  ?? "");
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError("Website name is required."); return; }
    setError(""); setLoading(true);

    const endpoint = existing ? `/api/websites/${existing.id}` : "/api/websites";
    const method   = existing ? "PATCH" : "POST";

    const res = await fetch(endpoint, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), url: url.trim() }),
    });

    setLoading(false);
    if (!res.ok) { setError((await res.json()).error ?? "Something went wrong."); return; }
    onSaved(await res.json());
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <Label>Website Name <span className="text-destructive">*</span></Label>
        <Input placeholder="e.g. Aviation Axis" value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <div className="space-y-1.5">
        <Label>URL <span className="text-xs text-muted-foreground">(optional)</span></Label>
        <Input placeholder="https://aviationaxis.com" value={url} onChange={(e) => setUrl(e.target.value)} />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2 justify-end pt-1">
        <Button type="button" variant="outline" onClick={onCancel} disabled={loading}>Cancel</Button>
        <Button type="submit" disabled={loading}>
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          {existing ? "Save Changes" : "Add Website"}
        </Button>
      </div>
    </form>
  );
}

// ─── Automation Form ──────────────────────────────────────────────────────────

function toDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function AutomationForm({ website, serviceAccountNames, onSaved, onCancel }: {
  website:             WebsiteRow;
  serviceAccountNames: string[];
  onSaved:             (updated: Partial<WebsiteRow> & { id: string }) => void;
  onCancel:            () => void;
}) {
  const [enabled,    setEnabled]    = useState(website.automationEnabled);
  const [startDate,  setStartDate]  = useState<string>(
    website.automationStartDate ? toDatetimeLocal(website.automationStartDate) : ""
  );
  const [gscAccount, setGscAccount] = useState(website.gscServiceAccountName);
  const [bingKey,    setBingKey]    = useState(website.bingApiKey);
  const [robotsUrl,  setRobotsUrl]  = useState(() => {
    const raw = website.robotsTxtUrl || (website.url ? `${website.url.replace(/\/$/, "")}/robots.txt` : "");
    return raw.replace(/([^:])\/\/+/g, "$1/");
  });
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState("");

  async function handleSave() {
    if (enabled && !gscAccount) {
      setError("Please select a GSC service account.");
      return;
    }
    if (enabled && !robotsUrl.trim()) {
      setError("robots.txt URL is required when automation is enabled.");
      return;
    }

    setError(""); setLoading(true);

    const automationStartDate = startDate ? new Date(startDate).toISOString() : null;

    const res = await fetch(`/api/websites/${website.id}/automation`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        automationEnabled:     enabled,
        automationStartDate,
        gscServiceAccountName: gscAccount,
        bingApiKey:            bingKey,
        robotsTxtUrl:          robotsUrl.trim(),
      }),
    });

    setLoading(false);
    if (!res.ok) { setError((await res.json()).error ?? "Something went wrong."); return; }

    onSaved({
      id:                    website.id,
      automationEnabled:     enabled,
      automationStartDate,
      gscServiceAccountName: gscAccount,
      bingApiKey:            bingKey,
      robotsTxtUrl:          robotsUrl.trim(),
    });
  }

  return (
    <div className="space-y-4">
      {/* Enable toggle */}
      <div className="flex items-center justify-between rounded-lg border p-3">
        <div>
          <p className="text-sm font-medium">Enable Automation</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Run sitemap scrape + URL indexing daily at 2:05 am
          </p>
        </div>
        <button
          type="button"
          onClick={() => setEnabled((v) => !v)}
          className={cn(
            "relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors",
            enabled ? "bg-violet-600" : "bg-muted"
          )}
        >
          <span className={cn(
            "pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-lg transition-transform",
            enabled ? "translate-x-5" : "translate-x-0"
          )} />
        </button>
      </div>

      {/* Start Date/Time */}
      <div className="space-y-1.5">
        <Label>
          Start Automation From
          <span className="text-xs text-muted-foreground ml-1">(optional)</span>
        </Label>
        <input
          type="datetime-local"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <p className="text-xs text-muted-foreground">
          Leave blank to start immediately. If set, cron will skip this website until the selected date &amp; time.
        </p>
      </div>

      {/* robots.txt URL */}
      <div className="space-y-1.5">
        <Label>
          robots.txt URL
          {enabled && <span className="text-destructive ml-1">*</span>}
        </Label>
        <Input
          placeholder="https://example.com/robots.txt"
          value={robotsUrl}
          onChange={(e) => setRobotsUrl(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Used once to discover all sitemaps. Leave blank to use default ({"{website_url}/robots.txt"}).
        </p>
      </div>

      {/* GSC Service Account */}
      <div className="space-y-1.5">
        <Label>
          GSC Service Account
          {enabled && <span className="text-destructive ml-1">*</span>}
        </Label>
        {serviceAccountNames.length === 0 ? (
          <p className="text-xs text-muted-foreground rounded-lg border p-3 bg-muted/30">
            No service accounts found. Add one in Settings first.
          </p>
        ) : (
          <SearchableSelect
            options={serviceAccountNames}
            value={gscAccount}
            onChange={setGscAccount}
            placeholder="— Select service account —"
          />
        )}
      </div>

      {/* Bing API Key */}
      <div className="space-y-1.5">
        <Label>
          Bing IndexNow API Key
          <span className="text-xs text-muted-foreground ml-1">(optional)</span>
        </Label>
        <Input
          placeholder="Leave blank to use shared key"
          value={bingKey}
          onChange={(e) => setBingKey(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Only needed if this website uses its own IndexNow key.
        </p>
      </div>

      {website.sitemapCount > 0 && (
        <div className="flex items-center justify-between rounded-lg border p-2.5 bg-muted/30">
          <p className="text-xs text-muted-foreground">
            {website.sitemapCount} sitemap(s) already discovered.
          </p>
          <button
            type="button"
            onClick={async () => {
              if (!confirm(`Clear all ${website.sitemapCount} saved sitemaps? They will be re-scraped on next run.`)) return;
              const res = await fetch(`/api/websites/${website.id}/automation`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  automationEnabled: enabled,
                  automationStartDate: startDate ? new Date(startDate).toISOString() : null,
                  gscServiceAccountName: gscAccount,
                  bingApiKey: bingKey,
                  robotsTxtUrl: robotsUrl.trim(),
                  clearSitemaps: true,
                }),
              });
              if (res.ok) {
                onSaved({ id: website.id, sitemapCount: 0 });
              }
            }}
            className="text-xs text-destructive hover:underline"
          >
            Clear sitemaps
          </button>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex gap-2 justify-end pt-1">
        <Button type="button" variant="outline" onClick={onCancel} disabled={loading}>Cancel</Button>
        <Button onClick={handleSave} disabled={loading}>
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          Save Settings
        </Button>
      </div>
    </div>
  );
}

// ─── Searchable Select ────────────────────────────────────────────────────────

function SearchableSelect({ options, value, onChange, placeholder }: {
  options:     string[];
  value:       string;
  onChange:    (v: string) => void;
  placeholder: string;
}) {
  const [open,   setOpen]   = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const filtered = options.filter((o) => o.toLowerCase().includes(search.toLowerCase()));

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => { setOpen((v) => !v); setSearch(""); }}
        className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm text-left flex items-center justify-between focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className={value ? "text-foreground" : "text-muted-foreground"}>
          {value || placeholder}
        </span>
        <svg className="h-4 w-4 text-muted-foreground shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-md">
          <div className="p-2 border-b">
            <input
              autoFocus
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search..."
              className="w-full h-8 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <ul className="max-h-48 overflow-y-auto py-1">
            <li>
              <button type="button" onClick={() => { onChange(""); setOpen(false); }}
                className="w-full text-left px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent">
                {placeholder}
              </button>
            </li>
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-xs text-muted-foreground">No results.</li>
            ) : filtered.map((o) => (
              <li key={o}>
                <button type="button" onClick={() => { onChange(o); setOpen(false); }}
                  className={cn("w-full text-left px-3 py-1.5 text-sm hover:bg-accent", o === value && "bg-accent font-medium")}>
                  {o}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Assign Form ──────────────────────────────────────────────────────────────

function AssignForm({ website, members, onSaved, onCancel }: {
  website: WebsiteRow;
  members: MemberOption[];
  onSaved: (w: WebsiteRow) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(
    new Set(website.assignedTo.map((a) => a.userId))
  );
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState("");

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function handleSave() {
    setError(""); setLoading(true);
    const assignedTo = members
      .filter((m) => selected.has(m.id))
      .map((m) => ({ userId: m.id, userName: m.name }));

    const res = await fetch(`/api/websites/${website.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignedTo }),
    });

    setLoading(false);
    if (!res.ok) { setError((await res.json()).error ?? "Something went wrong."); return; }
    onSaved(await res.json());
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Select the team members who should work on <span className="font-medium text-foreground">{website.name}</span>.
      </p>

      {members.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-4">No team members found.</p>
      ) : (
        <div className="space-y-1 max-h-72 overflow-y-auto rounded-lg border p-2">
          {members.map((m) => {
            const isChecked = selected.has(m.id);
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => toggle(m.id)}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors text-left",
                  isChecked ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted/50"
                )}
              >
                <div className={cn(
                  "flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold uppercase shrink-0",
                  isChecked ? "bg-primary text-primary-foreground" : "bg-muted"
                )}>
                  {m.name[0]}
                </div>
                <span className="flex-1">{m.name}</span>
                <div className={cn(
                  "h-4 w-4 rounded border-2 flex items-center justify-center shrink-0",
                  isChecked ? "bg-primary border-primary" : "border-muted-foreground/40"
                )}>
                  {isChecked && (
                    <svg className="h-2.5 w-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {selected.size} member{selected.size !== 1 ? "s" : ""} selected
      </p>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex gap-2 justify-end">
        <Button variant="outline" onClick={onCancel} disabled={loading}>Cancel</Button>
        <Button onClick={handleSave} disabled={loading}>
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          Save Assignments
        </Button>
      </div>
    </div>
  );
}
