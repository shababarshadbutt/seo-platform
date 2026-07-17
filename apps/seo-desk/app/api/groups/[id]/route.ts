import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, Group } from "@/lib/mongodb";

// PATCH /api/groups/[id] — super-admin only — update members list
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (session?.user.role !== "super-admin") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  await connectDB();

  const group = await Group.findById(params.id);
  if (!group) return Response.json({ error: "Group not found." }, { status: 404 });

  const body = await req.json();

  if ("memberUserIds" in body) {
    group.memberUserIds = body.memberUserIds;
  }
  if ("name" in body && body.name?.trim()) {
    group.name = body.name.trim();
  }

  await group.save();
  return Response.json({ id: group._id.toString(), name: group.name });
}

// DELETE /api/groups/[id] — super-admin only
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (session?.user.role !== "super-admin") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  await connectDB();

  const group = await Group.findByIdAndDelete(params.id);
  if (!group) return Response.json({ error: "Group not found." }, { status: 404 });

  return Response.json({ success: true });
}
