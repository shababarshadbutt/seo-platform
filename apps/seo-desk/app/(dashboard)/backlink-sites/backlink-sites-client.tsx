"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Loader2, Link2, ExternalLink, ClipboardPaste, X, Check, Repeat2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export interface BacklinkSiteRow {
  id:          string;
  url:         string;
  da:          number | null;
  spamScore:   number | null;
  niche:       string;
  notes:       string;
  reusable:    boolean;
  addedBy:     string;
  addedByName: string;
  createdAt:   string;
}

interface Props {
  sites:         BacklinkSiteRow[];
  viewerRole:    string;
  currentUserId: string;
}

export function BacklinkSitesClient({ sites: initial, viewerRole, currentUserId }: Props) {
  const router = useRouter();
  const [sites,           setSites]           = useState(initial);
  const [addOpen,         setAddOpen]         = useState(false);
  const [reusableOpen,    setReusableOpen]    = useState(false);
  const [deleteId,        setDeleteId]        = useState<string | null>(null);
  const [deleting,        setDeleting]        = useState(false);
  const [removingId,      setRemovingId]      = useState<string | null>(null);

  useEffect(() => { setSites(initial); }, [initial]);

  const isSuperAdmin = viewerRole === "super-admin";

  function canDelete(site: BacklinkSiteRow) {
    return isSuperAdmin || site.addedBy === currentUserId;
  }

  async function confirmDelete() {
    if (!deleteId) return;
    setDeleting(true);
    const res = await fetch(`/api/backlink-sites/${deleteId}`, { method: "DELETE" });
    setDeleting(false);
    if (res.ok) {
      setSites((prev) => prev.filter((s) => s.id !== deleteId));
      setDeleteId(null);
      router.refresh();
    } else {
      alert((await res.json()).error);
    }
  }

  async function removeFromReusable(site: BacklinkSiteRow) {
    setRemovingId(site.id);
    const res = await fetch(`/api/backlink-sites/${site.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reusable: false }),
    });
    setRemovingId(null);
    if (res.ok) {
      setSites((prev) => prev.map((s) => s.id === site.id ? { ...s, reusable: false } : s));
    } else {
      alert("Failed to update.");
    }
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold">Backlink Sites</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Approved source sites for team members to build backlinks on
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setReusableOpen(true)}>
            <Repeat2 className="h-4 w-4" />
            Reusable Sites
          </Button>
          <Button onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" />
            Add Sites
          </Button>
        </div>
      </div>

      {/* Table */}
      {sites.length === 0 ? (
        <div className="rounded-lg border bg-card p-12 text-center">
          <Link2 className="h-8 w-8 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No approved sites yet. Add the first one.</p>
        </div>
      ) : (
        <div className="rounded-lg border bg-card shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">URL</th>
                  <th className="text-center px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">DA</th>
                  <th className="text-center px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">Spam Score</th>
                  {isSuperAdmin && (
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">Added By</th>
                  )}
                  <th className="px-4 py-3 w-16" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {sites.map((site) => (
                  <tr key={site.id} className="hover:bg-muted/20 transition-colors group">
                    <td className="px-4 py-3 max-w-[280px]">
                      <div className="flex items-center gap-2">
                        <a
                          href={site.url.startsWith("http") ? site.url : `https://${site.url}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-blue-600 hover:underline text-xs font-medium"
                        >
                          <span className="truncate">{site.url}</span>
                          <ExternalLink className="h-3 w-3 shrink-0" />
                        </a>
                        {site.reusable && (
                          <span className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-blue-50 text-blue-600 border border-blue-200">
                            <Repeat2 className="h-2.5 w-2.5" />Reusable
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-center">
                      {site.da != null ? (
                        <span className={`font-semibold ${site.da >= 40 ? "text-green-600" : site.da >= 20 ? "text-yellow-600" : "text-red-500"}`}>
                          {site.da}
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {site.spamScore != null ? (
                        <span className={`font-semibold ${site.spamScore <= 5 ? "text-green-600" : site.spamScore <= 15 ? "text-yellow-600" : "text-red-500"}`}>
                          {site.spamScore}%
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </td>
                    {isSuperAdmin && (
                      <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          <div className="h-5 w-5 rounded-full bg-muted flex items-center justify-center text-[10px] font-bold uppercase shrink-0">
                            {site.addedByName[0]}
                          </div>
                          {site.addedByName.split(" ")[0]}
                        </div>
                      </td>
                    )}
                    <td className="px-4 py-3">
                      {canDelete(site) && (
                        <div className="opacity-0 group-hover:opacity-100 transition-opacity flex justify-end">
                          <Button
                            variant="ghost" size="sm"
                            className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                            onClick={() => setDeleteId(site.id)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Add sites sheet */}
      <Sheet open={addOpen} onOpenChange={setAddOpen}>
        <SheetContent side="right" className="w-full sm:max-w-2xl flex flex-col gap-0 p-0">
          <SheetHeader className="px-6 py-4 border-b shrink-0">
            <SheetTitle>Import Backlink Sites</SheetTitle>
            <p className="text-sm text-muted-foreground">
              Copy 3 columns from Google Sheets (URL · DA · Spam Score) and paste below.
            </p>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto">
            <AddSiteForm
              onSaved={(newSites) => {
                setSites((prev) => [...newSites, ...prev]);
                setAddOpen(false);
                router.refresh();
              }}
              onCancel={() => setAddOpen(false)}
            />
          </div>
        </SheetContent>
      </Sheet>

      {/* Reusable sites dialog */}
      <Dialog open={reusableOpen} onOpenChange={setReusableOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Repeat2 className="h-4 w-4 text-blue-600" />
              Reusable Sites
            </DialogTitle>
          </DialogHeader>
          <ReusableSitesPanel
            sites={sites}
            removingId={removingId}
            onRemove={removeFromReusable}
            onAdded={(newSite) => setSites((prev) => [newSite, ...prev])}
          />
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={!!deleteId} onOpenChange={(o) => { if (!o) setDeleteId(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Remove this site?</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will remove the site from the approved pool. Existing backlinks using this site won&apos;t be affected.
          </p>
          <div className="flex gap-2 justify-end mt-2">
            <Button variant="outline" onClick={() => setDeleteId(null)} disabled={deleting}>Cancel</Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting && <Loader2 className="h-4 w-4 animate-spin" />} Remove
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Reusable Sites Panel ─────────────────────────────────────────────────────

function ReusableSitesPanel({ sites, removingId, onRemove, onAdded }: {
  sites: BacklinkSiteRow[];
  removingId: string | null;
  onRemove: (site: BacklinkSiteRow) => void;
  onAdded: (site: BacklinkSiteRow) => void;
}) {
  const reusable = sites.filter((s) => s.reusable);
  const [url,     setUrl]     = useState("");
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState("");

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;
    setError(""); setLoading(true);
    const res = await fetch("/api/backlink-sites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sites: [{ url: trimmed, reusable: true }] }),
    });
    setLoading(false);
    if (!res.ok) { setError((await res.json()).error ?? "Something went wrong."); return; }
    const created: BacklinkSiteRow[] = await res.json();
    if (created[0]) { onAdded(created[0]); setUrl(""); }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        These sites stay visible in the dropdown even after a backlink has already been built on them.
      </p>

      {/* Add form */}
      <form onSubmit={handleAdd} className="flex gap-2">
        <Input
          placeholder="e.g. example.com"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="flex-1"
        />
        <Button type="submit" disabled={loading || !url.trim()}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          Add
        </Button>
      </form>
      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* List */}
      {reusable.length === 0 ? (
        <div className="rounded-lg border bg-muted/20 py-10 text-center">
          <Repeat2 className="h-7 w-7 text-muted-foreground/30 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No reusable sites yet.</p>
          <p className="text-xs text-muted-foreground mt-0.5">Add a site URL above to get started.</p>
        </div>
      ) : (
        <div className="rounded-lg border overflow-hidden max-h-72 overflow-y-auto">
          <div className="divide-y">
            {reusable.map((site) => (
              <div key={site.id} className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/30 group">
                <a
                  href={site.url.startsWith("http") ? site.url : `https://${site.url}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 flex items-center gap-1 text-sm text-blue-600 hover:underline min-w-0"
                >
                  <span className="truncate">{site.url}</span>
                  <ExternalLink className="h-3 w-3 shrink-0" />
                </a>
                {site.da != null && (
                  <span className="text-xs text-muted-foreground shrink-0">DA {site.da}</span>
                )}
                <button
                  type="button"
                  onClick={() => onRemove(site)}
                  disabled={removingId === site.id}
                  title="Remove from reusable"
                  className="shrink-0 text-muted-foreground hover:text-destructive transition-colors opacity-0 group-hover:opacity-100"
                >
                  {removingId === site.id
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <X className="h-3.5 w-3.5" />
                  }
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ParsedRow {
  url:       string;
  da:        string;
  spamScore: string;
  valid:     boolean;
}

// ─── TSV parser (Google Sheets copy format) ───────────────────────────────────

function parseTSV(text: string): ParsedRow[] {
  return text
    .split("\n")
    .map((line) => line.replace(/\r$/, "").trim())
    .filter(Boolean)
    .map((line) => {
      const cols  = line.split("\t");
      const url   = cols[0]?.trim() ?? "";
      const da    = cols[1]?.trim().replace(/[^0-9.]/g, "") ?? "";
      const spam  = cols[2]?.trim().replace(/[^0-9.]/g, "") ?? "";
      return { url, da, spamScore: spam, valid: url.length > 0 };
    })
    .filter((r) => r.url);
}

// ─── Add Site Form (bulk TSV import) ─────────────────────────────────────────

function AddSiteForm({ onSaved, onCancel }: {
  onSaved: (sites: BacklinkSiteRow[]) => void;
  onCancel: () => void;
}) {
  const [rows,   setRows]   = useState<ParsedRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState("");
  const [pasted,  setPasted]  = useState(false);
  const pasteRef = useRef<HTMLTextAreaElement>(null);

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    e.preventDefault();
    const text = e.clipboardData.getData("text");
    setRows(parseTSV(text));
    setPasted(true);
    setError("");
  }

  function removeRow(i: number) {
    setRows((prev) => prev.filter((_, idx) => idx !== i));
  }

  function updateCell(i: number, field: keyof ParsedRow, value: string) {
    setRows((prev) => prev.map((r, idx) => idx === i ? { ...r, [field]: value } : r));
  }

  function reset() {
    setRows([]); setPasted(false); setError("");
    setTimeout(() => pasteRef.current?.focus(), 50);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const valid = rows.filter((r) => r.url.trim());
    if (valid.length === 0) { setError("No valid rows to import."); return; }
    setError(""); setLoading(true);

    const res = await fetch("/api/backlink-sites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sites: valid.map((r) => ({ url: r.url.trim(), da: r.da, spamScore: r.spamScore })),
      }),
    });

    setLoading(false);
    if (!res.ok) { setError((await res.json()).error ?? "Something went wrong."); return; }
    onSaved(await res.json());
  }

  return (
    <form onSubmit={handleSubmit} className="px-6 py-5 space-y-5">
      {!pasted ? (
        <div className="space-y-2">
          <Label>Paste from Google Sheets</Label>
          <div className="relative">
            <textarea
              ref={pasteRef}
              autoFocus
              onPaste={handlePaste}
              readOnly
              placeholder=""
              className="w-full h-52 rounded-xl border-2 border-dashed border-muted-foreground/25 bg-muted/20 text-sm resize-none focus-visible:outline-none focus-visible:border-primary/50 focus-visible:bg-primary/5 transition-colors cursor-pointer"
            />
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none gap-3">
              <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center">
                <ClipboardPaste className="h-6 w-6 text-muted-foreground" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium">Click here, then press Ctrl+V</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Select 3 columns in Google Sheets: <span className="font-medium">URL · DA · Spam Score</span>
                </p>
              </div>
            </div>
          </div>
          <div className="rounded-lg bg-muted/40 border px-4 py-3 text-xs text-muted-foreground space-y-1">
            <p className="font-medium text-foreground">How to copy from Google Sheets:</p>
            <p>1. Select the 3 columns (URL, DA, Spam Score) — header row optional</p>
            <p>2. Press <kbd className="px-1.5 py-0.5 rounded border bg-background font-mono">Ctrl+C</kbd></p>
            <p>3. Click the paste zone above and press <kbd className="px-1.5 py-0.5 rounded border bg-background font-mono">Ctrl+V</kbd></p>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <Label>{rows.length} site{rows.length !== 1 ? "s" : ""} ready to import</Label>
              <p className="text-xs text-muted-foreground mt-0.5">Review and edit if needed. Click × to remove a row.</p>
            </div>
            <button type="button" onClick={reset} className="text-xs text-muted-foreground hover:text-foreground underline transition-colors">
              Paste again
            </button>
          </div>
          <div className="rounded-lg border overflow-hidden">
            <div className="max-h-72 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/60 border-b">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">#</th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">URL</th>
                    <th className="text-center px-3 py-2 font-medium text-muted-foreground w-16">DA</th>
                    <th className="text-center px-3 py-2 font-medium text-muted-foreground w-20">Spam %</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((row, i) => (
                    <tr key={i} className={cn("group", !row.url.trim() && "bg-red-50 dark:bg-red-950/20")}>
                      <td className="px-3 py-1.5 text-muted-foreground">{i + 1}</td>
                      <td className="px-3 py-1.5">
                        <input type="text" value={row.url} onChange={(e) => updateCell(i, "url", e.target.value)}
                          className="w-full bg-transparent focus:outline-none focus:bg-background focus:ring-1 focus:ring-ring rounded px-1 -mx-1 text-xs" />
                      </td>
                      <td className="px-3 py-1.5 text-center">
                        <input type="text" value={row.da} onChange={(e) => updateCell(i, "da", e.target.value)}
                          placeholder="—" className="w-12 text-center bg-transparent focus:outline-none focus:bg-background focus:ring-1 focus:ring-ring rounded px-1 text-xs" />
                      </td>
                      <td className="px-3 py-1.5 text-center">
                        <input type="text" value={row.spamScore} onChange={(e) => updateCell(i, "spamScore", e.target.value)}
                          placeholder="—" className="w-14 text-center bg-transparent focus:outline-none focus:bg-background focus:ring-1 focus:ring-ring rounded px-1 text-xs" />
                      </td>
                      <td className="px-2 py-1.5">
                        <button type="button" onClick={() => removeRow(i)}
                          className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive">
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex gap-2 justify-end pt-1">
        <Button type="button" variant="outline" onClick={onCancel} disabled={loading}>Cancel</Button>
        {pasted && rows.length > 0 && (
          <Button type="submit" disabled={loading || rows.filter((r) => r.url.trim()).length === 0}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Import {rows.filter((r) => r.url.trim()).length} Site{rows.filter((r) => r.url.trim()).length !== 1 ? "s" : ""}
          </Button>
        )}
      </div>
    </form>
  );
}
