import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, User } from "@/lib/mongodb";
import { UsersClient, type UserRow } from "./users-client";

export default async function UsersPage() {
  const session = await getServerSession(authOptions);

  await connectDB();
  const rawUsers = await User.find({}).sort({ createdAt: -1 }).lean();

  const users: UserRow[] = rawUsers.map((u) => ({
    id: u._id.toString(),
    name: u.name,
    email: u.email,
    role: u.role,
    isActive: u.isActive,
    createdAt: u.createdAt.toISOString(),
  }));

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">User Management</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {users.length} team member{users.length !== 1 ? "s" : ""}
        </p>
      </div>
      <UsersClient users={users} currentUserId={session!.user.id} currentUserRole={session!.user.role} />
    </div>
  );
}
