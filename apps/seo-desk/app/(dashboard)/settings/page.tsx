import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, Settings, User, Group } from "@/lib/mongodb";
import { SettingsClient } from "./settings-client";
import { CleanupButton } from "./cleanup-button";

export default async function SettingsPage() {
  await getServerSession(authOptions);

  await connectDB();

  const [settings, rawUsers, rawGroups] = await Promise.all([
    Settings.findOne({ singleton: true }).lean(),
    User.find({ isActive: true }).select("_id name email role").sort({ name: 1 }).lean(),
    Group.find({}).sort({ name: 1 }).lean(),
  ]);

  const users = rawUsers.map((u) => ({
    id: u._id.toString(),
    name: u.name,
    email: u.email,
    role: u.role,
  }));

  // Resolve group member/lead names
  const userMap = Object.fromEntries(users.map((u) => [u.id, u]));
  const groups = rawGroups.map((g) => ({
    id: g._id.toString(),
    name: g.name,
    leadUserId: g.leadUserId.toString(),
    memberUserIds: g.memberUserIds.map((id) => id.toString()),
  }));

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h2 className="text-2xl font-bold">Settings</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Manage Google service accounts, property lists, and team groups.
        </p>
      </div>

      <SettingsClient
        serviceAccounts={(settings?.serviceAccounts ?? []).map((a) => ({ name: a.name }))}
        gscProperties={settings?.gscProperties ?? []}
        ga4Properties={settings?.ga4Properties ?? []}
        users={users}
        groups={groups}
        userMap={userMap}
      />

      <CleanupButton />
    </div>
  );
}
