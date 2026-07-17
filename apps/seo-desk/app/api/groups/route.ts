import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, Group, User } from "@/lib/mongodb";

// GET /api/groups
// super-admin: all groups with member details
// sub-lead: only their own group
export async function GET() {
  const session = await getServerSession(authOptions);
  const role = session?.user.role;
  const userId = session?.user.id;

  if (!role || role === "admin") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  await connectDB();

  const filter = role === "super-admin" ? {} : { leadUserId: userId };
  const groups = await Group.find(filter).sort({ name: 1 }).lean();

  // Collect all referenced user IDs
  const allUserIds = new Set<string>();
  for (const g of groups) {
    allUserIds.add(g.leadUserId.toString());
    g.memberUserIds.forEach((id) => allUserIds.add(id.toString()));
  }

  const users = await User.find({ _id: { $in: Array.from(allUserIds) } })
    .select("_id name email role")
    .lean();

  const userMap = Object.fromEntries(users.map((u) => [u._id.toString(), u]));

  return Response.json(
    groups.map((g) => ({
      id: g._id.toString(),
      name: g.name,
      lead: userMap[g.leadUserId.toString()]
        ? {
            id: g.leadUserId.toString(),
            name: userMap[g.leadUserId.toString()].name,
            email: userMap[g.leadUserId.toString()].email,
          }
        : null,
      members: g.memberUserIds.map((id) => {
        const u = userMap[id.toString()];
        return u ? { id: id.toString(), name: u.name, email: u.email } : null;
      }).filter(Boolean),
    }))
  );
}

// POST /api/groups — super-admin only
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user.role !== "super-admin") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const { name, leadUserId, memberUserIds = [] } = await req.json();

  if (!name?.trim()) {
    return Response.json({ error: "Group name is required." }, { status: 400 });
  }
  if (!leadUserId) {
    return Response.json({ error: "Group lead is required." }, { status: 400 });
  }

  await connectDB();

  const lead = await User.findById(leadUserId);
  if (!lead || lead.role !== "sub-lead") {
    return Response.json({ error: "Lead must be a user with Supervisor role." }, { status: 400 });
  }

  const existing = await Group.findOne({ leadUserId });
  if (existing) {
    return Response.json(
      { error: `${lead.name} is already leading group "${existing.name}".` },
      { status: 409 }
    );
  }

  const group = await Group.create({ name: name.trim(), leadUserId, memberUserIds });

  return Response.json({ id: group._id.toString(), name: group.name }, { status: 201 });
}
