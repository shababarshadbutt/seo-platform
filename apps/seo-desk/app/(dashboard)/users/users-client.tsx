"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { UserPlus, ShieldCheck, Crown, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export interface UserRow {
  id: string;
  name: string;
  email: string;
  role: string;
  isActive: boolean;
  createdAt: string;
}

interface UsersClientProps {
  users: UserRow[];
  currentUserId: string;
  currentUserRole: string;
}

function roleRank(role: string): number {
  if (role === "super-admin") return 3;
  if (role === "sub-lead") return 2;
  if (role === "admin") return 1;
  return 0;
}

function roleLabel(role: string) {
  if (role === "super-admin") return "Admin";
  if (role === "sub-lead") return "Supervisor";
  return "User";
}

function RoleBadge({ role }: { role: string }) {
  if (role === "super-admin") {
    return (
      <Badge className="gap-1 bg-yellow-500/15 text-yellow-700 border-yellow-400/30 hover:bg-yellow-500/15">
        <Crown className="h-3 w-3" />
        Admin
      </Badge>
    );
  }
  if (role === "sub-lead") {
    return (
      <Badge className="gap-1 bg-blue-500/15 text-blue-700 border-blue-400/30 hover:bg-blue-500/15">
        <ShieldCheck className="h-3 w-3" />
        Supervisor
      </Badge>
    );
  }
  return (
    <Badge variant="default" className="gap-1">
      <ShieldCheck className="h-3 w-3" />
      User
    </Badge>
  );
}

export function UsersClient({ users: initial, currentUserId, currentUserRole }: UsersClientProps) {
  const router = useRouter();
  const [users, setUsers] = useState(initial);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<UserRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const myRank = roleRank(currentUserRole);

  function updateUser(updated: UserRow) {
    setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
  }

  async function toggleActive(user: UserRow) {
    const res = await fetch(`/api/users/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !user.isActive }),
    });
    if (res.ok) {
      updateUser(await res.json());
    } else {
      alert((await res.json()).error);
    }
  }

  async function changeRole(user: UserRow, newRole: string) {
    const res = await fetch(`/api/users/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: newRole }),
    });
    if (res.ok) {
      updateUser(await res.json());
    } else {
      alert((await res.json()).error);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    const res = await fetch(`/api/users/${deleteTarget.id}`, { method: "DELETE" });
    setDeleting(false);
    if (res.ok) {
      setUsers((prev) => prev.filter((u) => u.id !== deleteTarget.id));
      setDeleteTarget(null);
      router.refresh();
    } else {
      alert((await res.json()).error);
    }
  }

  function onInvited(newUser: UserRow) {
    setUsers((prev) => [newUser, ...prev]);
    setInviteOpen(false);
    router.refresh();
  }

  // Available roles you can assign to a target (only super-admin can manage)
  function assignableRoles(targetRole: string): string[] {
    const all = ["admin", "sub-lead", "super-admin"];
    return all.filter(
      (r) => roleRank(r) < myRank && r !== targetRole
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
          <DialogTrigger asChild>
            <Button>
              <UserPlus className="h-4 w-4" />
              Invite user
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Invite a new team member</DialogTitle>
            </DialogHeader>
            <InviteForm onSuccess={onInvited} currentUserRole={currentUserRole} />
          </DialogContent>
        </Dialog>
      </div>

      <div className="rounded-lg border bg-card shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Name</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Email</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Role</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Joined</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {users.map((user) => {
              const isSelf = user.id === currentUserId;
              const canManage = !isSelf && roleRank(user.role) < myRank;
              // super-admin can delete anyone (including other super-admins) except themselves
              const canDelete = !isSelf && myRank === 3;
              const roles = assignableRoles(user.role);

              return (
                <tr key={user.id} className="hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-3 font-medium">
                    <div className="flex items-center gap-2">
                      <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-xs font-bold uppercase">
                        {user.name[0]}
                      </div>
                      {user.name}
                      {isSelf && (
                        <span className="text-xs text-muted-foreground">(you)</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{user.email}</td>
                  <td className="px-4 py-3">
                    <RoleBadge role={user.role} />
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={user.isActive ? "success" : "outline"}>
                      {user.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground text-xs">
                    {new Date(user.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3">
                    {(canManage || canDelete) && (
                      <div className="flex gap-2 justify-end">
                        {canManage && roles.length > 0 && (
                          <select
                            className="h-8 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            value={user.role}
                            onChange={(e) => changeRole(user, e.target.value)}
                          >
                            <option value={user.role} disabled>{roleLabel(user.role)}</option>
                            {roles.map((r) => (
                              <option key={r} value={r}>{roleLabel(r)}</option>
                            ))}
                          </select>
                        )}
                        {canManage && (
                          <Button
                            variant={user.isActive ? "destructive" : "outline"}
                            size="sm"
                            onClick={() => toggleActive(user)}
                          >
                            {user.isActive ? "Deactivate" : "Reactivate"}
                          </Button>
                        )}
                        {canDelete && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive hover:bg-destructive/10"
                            onClick={() => setDeleteTarget(user)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── Delete confirm dialog ── */}
      <Dialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete user?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to permanently delete{" "}
            <span className="font-semibold text-foreground">{deleteTarget?.name}</span>?
            This action cannot be undone.
          </p>
          <div className="flex gap-2 justify-end mt-2">
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Cancel
            </Button>
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

// ─── Invite form ─────────────────────────────────────────────────────────────

function InviteForm({
  onSuccess,
  currentUserRole,
}: {
  onSuccess: (user: UserRow) => void;
  currentUserRole: string;
}) {
  const isSuperAdmin = currentUserRole === "super-admin";
  const [form, setForm] = useState({ name: "", email: "", role: "admin", password: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null);

  function set(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const res = await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });

    setLoading(false);

    if (!res.ok) {
      setError((await res.json()).error);
      return;
    }

    const newUser = await res.json();
    setCreated({ email: form.email, password: form.password });
    onSuccess(newUser);
  }

  if (created) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg bg-green-50 border border-green-200 p-4 text-sm space-y-1">
          <p className="font-semibold text-green-800">User created successfully</p>
          <p className="text-green-700">Share these credentials with the new team member:</p>
          <div className="mt-2 rounded bg-white border p-3 font-mono text-xs space-y-1">
            <p><span className="text-muted-foreground">Email:</span> {created.email}</p>
            <p><span className="text-muted-foreground">Password:</span> {created.password}</p>
          </div>
          <p className="text-xs text-green-600 mt-2">Ask them to change their password after first login.</p>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="invite-name">Full name</Label>
        <Input
          id="invite-name"
          placeholder="Jane Smith"
          value={form.name}
          onChange={(e) => set("name", e.target.value)}
          required
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="invite-email">Email</Label>
        <Input
          id="invite-email"
          type="email"
          placeholder="jane@example.com"
          value={form.email}
          onChange={(e) => set("email", e.target.value)}
          required
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="invite-password">Temporary password</Label>
        <Input
          id="invite-password"
          type="text"
          placeholder="Min. 8 characters"
          value={form.password}
          onChange={(e) => set("password", e.target.value)}
          required
          minLength={8}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="invite-role">Role</Label>
        <select
          id="invite-role"
          className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={form.role}
          onChange={(e) => set("role", e.target.value)}
        >
          <option value="admin">User</option>
          {isSuperAdmin && <option value="sub-lead">Supervisor</option>}
          {isSuperAdmin && <option value="super-admin">Admin</option>}
        </select>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" className="w-full" disabled={loading}>
        {loading && <Loader2 className="h-4 w-4 animate-spin" />}
        Create user
      </Button>
    </form>
  );
}
