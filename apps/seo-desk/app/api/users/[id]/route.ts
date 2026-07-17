import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, User } from "@/lib/mongodb";

// Role rank: higher = more powerful
function roleRank(role?: string): number {
  if (role === "super-admin") return 3;
  if (role === "sub-lead") return 2;
  if (role === "admin") return 1;
  return 0;
}

// PATCH /api/users/[id] — update role or isActive
// Rules:
//   - You cannot modify your own account here
//   - You can only modify users with strictly lower role rank than yourself
//   - You can only assign roles up to your own rank
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  const myRole = session?.user.role;

  if (roleRank(myRole) < 3) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  if (params.id === session!.user.id) {
    return Response.json({ error: "You cannot modify your own account here." }, { status: 400 });
  }

  await connectDB();

  const target = await User.findById(params.id);
  if (!target) return Response.json({ error: "User not found." }, { status: 404 });

  // Cannot modify a user with equal or higher rank
  if (roleRank(target.role) >= roleRank(myRole)) {
    return Response.json(
      { error: "You do not have permission to modify this account." },
      { status: 403 }
    );
  }

  const body = await req.json();
  const allowedFields: Record<string, unknown> = {};

  if ("isActive" in body) allowedFields.isActive = Boolean(body.isActive);

  if ("role" in body) {
    const newRole = body.role as string;
    const allowedRoles = myRole === "super-admin"
      ? ["admin", "sub-lead", "super-admin"]
      : [];

    if (allowedRoles.includes(newRole) && roleRank(newRole) <= roleRank(myRole)) {
      allowedFields.role = newRole;
    }
  }

  if (Object.keys(allowedFields).length === 0) {
    return Response.json({ error: "No valid fields to update." }, { status: 400 });
  }

  // Prevent removing the last super-admin
  if (
    (allowedFields.role === "admin" || allowedFields.role === "member" || allowedFields.isActive === false) &&
    target.role === "super-admin"
  ) {
    const superAdminCount = await User.countDocuments({ role: "super-admin", isActive: true });
    if (superAdminCount <= 1) {
      return Response.json(
        { error: "Cannot demote or deactivate the last super-admin." },
        { status: 400 }
      );
    }
  }

  const updated = await User.findByIdAndUpdate(params.id, allowedFields, { new: true }).lean();
  if (!updated) return Response.json({ error: "User not found." }, { status: 404 });

  return Response.json({
    id: updated._id.toString(),
    name: updated.name,
    email: updated.email,
    role: updated.role,
    isActive: updated.isActive,
    createdAt: updated.createdAt.toISOString(),
  });
}

// DELETE /api/users/[id] — permanently remove a user (super-admin only)
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  const myRole = session?.user.role;

  if (roleRank(myRole) < 3) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  if (params.id === session!.user.id) {
    return Response.json({ error: "You cannot delete your own account." }, { status: 400 });
  }

  await connectDB();

  const target = await User.findById(params.id);
  if (!target) return Response.json({ error: "User not found." }, { status: 404 });

  // super-admin can delete any account (including other super-admins) except themselves
  // lower roles cannot delete equal/higher ranks
  if (roleRank(myRole) < 3 && roleRank(target.role) >= roleRank(myRole)) {
    return Response.json({ error: "You do not have permission to delete this account." }, { status: 403 });
  }

  await User.findByIdAndDelete(params.id);
  return Response.json({ success: true });
}
