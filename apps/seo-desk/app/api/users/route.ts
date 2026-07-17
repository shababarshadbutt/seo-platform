import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, User } from "@/lib/mongodb";
import bcrypt from "bcryptjs";

export const dynamic = "force-dynamic";

function isPrivileged(role?: string) {
  return role === "admin" || role === "super-admin";
}

// GET /api/users — list all users (super-admin only)
export async function GET() {
  const session = await getServerSession(authOptions);
  if (session?.user.role !== "super-admin") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  await connectDB();
  const users = await User.find({}).sort({ createdAt: -1 }).lean();

  return Response.json(
    users.map((u) => ({
      id: u._id.toString(),
      name: u.name,
      email: u.email,
      role: u.role,
      isActive: u.isActive,
      createdAt: u.createdAt.toISOString(),
    }))
  );
}

// POST /api/users — create a new user
// admin: can only create members
// super-admin: can create member, admin, super-admin
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!isPrivileged(session?.user.role)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const { name, email, role, password } = await req.json();

  if (!name?.trim() || !email?.trim() || !password?.trim()) {
    return Response.json({ error: "Name, email, and password are required." }, { status: 400 });
  }

  // Only super-admin can create users (and assign any role below super-admin)
  if (session!.user.role !== "super-admin") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const validRoles = ["admin", "sub-lead", "super-admin"];
  const assignedRole = validRoles.includes(role) ? role : "admin";

  await connectDB();

  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) {
    return Response.json({ error: "A user with this email already exists." }, { status: 409 });
  }

  const hashed = await bcrypt.hash(password, 12);

  const user = await User.create({
    name: name.trim(),
    email: email.toLowerCase().trim(),
    password: hashed,
    role: assignedRole,
    isActive: true,
  });

  return Response.json(
    {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      role: user.role,
      isActive: user.isActive,
      createdAt: user.createdAt.toISOString(),
    },
    { status: 201 }
  );
}
