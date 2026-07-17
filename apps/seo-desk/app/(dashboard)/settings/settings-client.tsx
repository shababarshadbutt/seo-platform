"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Plus, Loader2, ShieldAlert, KeyRound, Users, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";

interface ServiceAccount { name: string }
interface GscProperty { url: string; displayName: string }
interface Ga4Property { propertyId: string; displayName: string }

export interface UserOption { id: string; name: string; email: string; role: string }
export interface GroupData {
  id: string;
  name: string;
  leadUserId: string;
  memberUserIds: string[];
}

interface SettingsClientProps {
  serviceAccounts: ServiceAccount[];
  gscProperties: GscProperty[];
  ga4Properties: Ga4Property[];
  users: UserOption[];
  groups: GroupData[];
  userMap: Record<string, UserOption>;
}

export function SettingsClient(props: SettingsClientProps) {
  return (
    <div className="space-y-6">
      <ServiceAccountsCard initial={props.serviceAccounts} />
      <GscPropertiesCard initial={props.gscProperties} />
      <Ga4PropertiesCard initial={props.ga4Properties} />
      <GroupsCard initialGroups={props.groups} users={props.users} userMap={props.userMap} />
    </div>
  );
}

// ─── Service Accounts ────────────────────────────────────────────────────────

function ServiceAccountsCard({ initial }: { initial: ServiceAccount[] }) {
  const router = useRouter();
  const [accounts, setAccounts] = useState(initial);
  const [name, setName] = useState("");
  const [json, setJson] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setError(""); setSuccess(""); setLoading(true);

    const res = await fetch("/api/settings/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, credentialsJson: json }),
    });

    setLoading(false);

    if (!res.ok) {
      const data = await res.json();
      setError(data.error);
      return;
    }

    const data = await res.json();
    setAccounts(data.serviceAccounts);
    setName(""); setJson("");
    setSuccess(`"${name}" added successfully.`);
    router.refresh();
  }

  async function handleRemove(accountName: string) {
    if (!confirm(`Remove service account "${accountName}"? Scripts using it will stop working.`)) return;
    setLoading(true);

    const res = await fetch("/api/settings/credentials", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: accountName }),
    });

    setLoading(false);

    if (res.ok) {
      const data = await res.json();
      setAccounts(data.serviceAccounts);
      router.refresh();
    }
  }

  return (
    <div className="rounded-lg border bg-card p-5 shadow-sm space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold">Google Service Accounts</h3>
          <p className="text-sm text-muted-foreground">
            Add one per Google Cloud project. Scripts will let you pick which one to use.
          </p>
        </div>
        <Badge variant={accounts.length > 0 ? "success" : "outline"}
          className={accounts.length === 0 ? "text-yellow-700 border-yellow-300 bg-yellow-50" : ""}>
          {accounts.length > 0
            ? `${accounts.length} configured`
            : <><ShieldAlert className="h-3 w-3 inline mr-1" />None</>}
        </Badge>
      </div>

      {/* Existing accounts list */}
      {accounts.length > 0 && (
        <div className="space-y-2">
          {accounts.map((account) => (
            <div key={account.name}
              className="flex items-center justify-between rounded-md border px-3 py-2">
              <div className="flex items-center gap-2 text-sm">
                <KeyRound className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">{account.name}</span>
              </div>
              <Button variant="ghost" size="sm" onClick={() => handleRemove(account.name)}
                disabled={loading}>
                <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Add new account form */}
      <form onSubmit={handleAdd} className="space-y-3 pt-2 border-t">
        <p className="text-sm font-medium pt-1">Add a service account</p>
        <div className="space-y-1.5">
          <Label htmlFor="sa-name">Account name / label</Label>
          <Input
            id="sa-name"
            placeholder="e.g. ASAP Main Account"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sa-json">Service account JSON</Label>
          <Textarea
            id="sa-json"
            className="font-mono text-xs min-h-[140px]"
            placeholder={'{\n  "type": "service_account",\n  "project_id": "...",\n  ...\n}'}
            value={json}
            onChange={(e) => setJson(e.target.value)}
            required
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {success && <p className="text-sm text-green-600">{success}</p>}
        <Button type="submit" size="sm" disabled={loading || !name.trim() || !json.trim()}>
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          <Plus className="h-4 w-4" />
          Add account
        </Button>
      </form>
    </div>
  );
}

// ─── GSC Properties ──────────────────────────────────────────────────────────

function GscPropertiesCard({ initial }: { initial: GscProperty[] }) {
  const router = useRouter();
  const [properties, setProperties] = useState(initial);
  const [newUrl, setNewUrl] = useState("");
  const [newName, setNewName] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(updated: GscProperty[]) {
    setSaving(true);
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gscProperties: updated }),
    });
    setSaving(false);
    if (res.ok) {
      const data = await res.json();
      setProperties(data.gscProperties);
      router.refresh();
    }
  }

  function add() {
    if (!newUrl.trim() || !newName.trim()) return;
    save([...properties, { url: newUrl.trim(), displayName: newName.trim() }]);
    setNewUrl(""); setNewName("");
  }

  return (
    <div className="rounded-lg border bg-card p-5 shadow-sm space-y-4">
      <div>
        <h3 className="font-semibold">Google Search Console Properties</h3>
        <p className="text-sm text-muted-foreground">Properties available for use in GSC scripts.</p>
      </div>

      {properties.length > 0 && (
        <div className="space-y-2">
          {properties.map((p, i) => (
            <div key={i} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
              <div>
                <span className="font-medium">{p.displayName}</span>
                <span className="text-muted-foreground ml-2 text-xs">{p.url}</span>
              </div>
              <Button variant="ghost" size="sm"
                onClick={() => save(properties.filter((_, j) => j !== i))} disabled={saving}>
                <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2 items-end">
        <div className="space-y-1 flex-1">
          <Label className="text-xs">Property URL</Label>
          <Input placeholder="https://example.com/" value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())} />
        </div>
        <div className="space-y-1 flex-1">
          <Label className="text-xs">Display name</Label>
          <Input placeholder="Example.com" value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())} />
        </div>
        <Button size="sm" onClick={add} disabled={saving || !newUrl.trim() || !newName.trim()}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}

// ─── Groups ───────────────────────────────────────────────────────────────────

function GroupsCard({
  initialGroups,
  users,
  userMap,
}: {
  initialGroups: GroupData[];
  users: UserOption[];
  userMap: Record<string, UserOption>;
}) {
  const router = useRouter();
  const [groups, setGroups] = useState(initialGroups);
  const [newName, setNewName] = useState("");
  const [newLeadId, setNewLeadId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [localUserMap] = useState(userMap);

  const subLeads = users.filter((u) => u.role === "sub-lead"); // "sub-lead" is stored as-is in DB, shown as "Supervisor"
  const regularUsers = users.filter((u) => u.role === "admin");

  async function createGroup(e: React.FormEvent) {
    e.preventDefault();
    setError(""); setSaving(true);
    const res = await fetch("/api/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName, leadUserId: newLeadId }),
    });
    setSaving(false);
    if (!res.ok) { setError((await res.json()).error); return; }
    setNewName(""); setNewLeadId("");
    router.refresh();
    // Refetch groups
    const gr = await fetch("/api/groups");
    if (gr.ok) setGroups(await gr.json().then(mapGroups));
  }

  function mapGroups(data: { id: string; name: string; lead: { id: string } | null; members: { id: string }[] }[]): GroupData[] {
    return data.map((g) => ({
      id: g.id,
      name: g.name,
      leadUserId: g.lead?.id ?? "",
      memberUserIds: g.members.map((m) => m.id),
    }));
  }

  async function deleteGroup(id: string, name: string) {
    if (!confirm(`Delete group "${name}"?`)) return;
    const res = await fetch(`/api/groups/${id}`, { method: "DELETE" });
    if (res.ok) {
      setGroups((prev) => prev.filter((g) => g.id !== id));
      router.refresh();
    }
  }

  async function toggleMember(group: GroupData, userId: string) {
    const currentIds = group.memberUserIds;
    const updated = currentIds.includes(userId)
      ? currentIds.filter((id) => id !== userId)
      : [...currentIds, userId];

    const res = await fetch(`/api/groups/${group.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberUserIds: updated }),
    });
    if (res.ok) {
      setGroups((prev) =>
        prev.map((g) => g.id === group.id ? { ...g, memberUserIds: updated } : g)
      );
    }
  }

  return (
    <div className="rounded-lg border bg-card p-5 shadow-sm space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold">Team Groups</h3>
          <p className="text-sm text-muted-foreground">
            Assign supervisors to groups. Each supervisor can view their group members&apos; activity.
          </p>
        </div>
        <Badge variant={groups.length > 0 ? "success" : "outline"}>
          {groups.length} {groups.length === 1 ? "group" : "groups"}
        </Badge>
      </div>

      {/* Existing groups */}
      {groups.length > 0 && (
        <div className="space-y-2">
          {groups.map((group) => {
            const lead = localUserMap[group.leadUserId];
            const isExpanded = expandedId === group.id;
            return (
              <div key={group.id} className="rounded-md border overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 bg-muted/30">
                  <div className="flex items-center gap-2 text-sm">
                    <Users className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium">{group.name}</span>
                    <span className="text-muted-foreground text-xs">
                      Supervisor: {lead?.name ?? "Unknown"}
                    </span>
                    <Badge variant="outline" className="text-xs">
                      {group.memberUserIds.length} member{group.memberUserIds.length !== 1 ? "s" : ""}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost" size="sm"
                      onClick={() => setExpandedId(isExpanded ? null : group.id)}
                    >
                      {isExpanded
                        ? <ChevronUp className="h-3.5 w-3.5" />
                        : <ChevronDown className="h-3.5 w-3.5" />}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => deleteGroup(group.id, group.name)}>
                      <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                    </Button>
                  </div>
                </div>

                {isExpanded && (
                  <div className="px-3 py-3 border-t space-y-2">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      Assign / remove members
                    </p>
                    {regularUsers.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No regular users found.</p>
                    ) : (
                      <div className="grid grid-cols-2 gap-1.5">
                        {regularUsers.map((u) => {
                          const isMember = group.memberUserIds.includes(u.id);
                          return (
                            <button
                              key={u.id}
                              onClick={() => toggleMember(group, u.id)}
                              className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs text-left transition-colors ${
                                isMember
                                  ? "border-primary/50 bg-primary/5 text-primary"
                                  : "hover:bg-muted/50"
                              }`}
                            >
                              <div className={`h-2 w-2 rounded-full flex-shrink-0 ${isMember ? "bg-primary" : "bg-muted-foreground/30"}`} />
                              {u.name}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Create group form */}
      <form onSubmit={createGroup} className="space-y-3 pt-2 border-t">
        <p className="text-sm font-medium pt-1">Create a new group</p>
        <div className="flex gap-2">
          <div className="flex-1 space-y-1">
            <Label className="text-xs">Group name</Label>
            <Input
              placeholder="e.g. SEO Team A"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              required
            />
          </div>
          <div className="flex-1 space-y-1">
            <Label className="text-xs">Supervisor</Label>
            <select
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={newLeadId}
              onChange={(e) => setNewLeadId(e.target.value)}
              required
            >
              <option value="">Select supervisor…</option>
              {subLeads.map((u) => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </select>
          </div>
        </div>
        {subLeads.length === 0 && (
          <p className="text-xs text-yellow-600">
            No supervisors found. Go to Users to assign the Supervisor role first.
          </p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" size="sm" disabled={saving || !newName.trim() || !newLeadId}>
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          <Plus className="h-4 w-4" />
          Create group
        </Button>
      </form>
    </div>
  );
}

// ─── GA4 Properties ───────────────────────────────────────────────────────────

function Ga4PropertiesCard({ initial }: { initial: Ga4Property[] }) {
  const router = useRouter();
  const [properties, setProperties] = useState(initial);
  const [newId, setNewId] = useState("");
  const [newName, setNewName] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(updated: Ga4Property[]) {
    setSaving(true);
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ga4Properties: updated }),
    });
    setSaving(false);
    if (res.ok) {
      const data = await res.json();
      setProperties(data.ga4Properties);
      router.refresh();
    }
  }

  function add() {
    if (!newId.trim() || !newName.trim()) return;
    save([...properties, { propertyId: newId.trim(), displayName: newName.trim() }]);
    setNewId(""); setNewName("");
  }

  return (
    <div className="rounded-lg border bg-card p-5 shadow-sm space-y-4">
      <div>
        <h3 className="font-semibold">GA4 Properties</h3>
        <p className="text-sm text-muted-foreground">Properties available for the GA4 Reporter script.</p>
      </div>

      {properties.length > 0 && (
        <div className="space-y-2">
          {properties.map((p, i) => (
            <div key={i} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
              <div>
                <span className="font-medium">{p.displayName}</span>
                <span className="text-muted-foreground ml-2 text-xs font-mono">{p.propertyId}</span>
              </div>
              <Button variant="ghost" size="sm"
                onClick={() => save(properties.filter((_, j) => j !== i))} disabled={saving}>
                <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2 items-end">
        <div className="space-y-1 flex-1">
          <Label className="text-xs">Property ID</Label>
          <Input placeholder="properties/123456789" value={newId}
            onChange={(e) => setNewId(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())} />
        </div>
        <div className="space-y-1 flex-1">
          <Label className="text-xs">Display name</Label>
          <Input placeholder="Example.com (GA4)" value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())} />
        </div>
        <Button size="sm" onClick={add} disabled={saving || !newId.trim() || !newName.trim()}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}
