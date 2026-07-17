import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, AuditChecklist } from "@/lib/mongodb";

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "super-admin") return Response.json({ error: "Forbidden" }, { status: 403 });

  await connectDB();
  const body = await req.json();
  const update: Record<string, unknown> = {};
  if ("heading" in body) update.heading = body.heading?.trim();
  if ("description" in body) update.description = body.description?.trim() ?? "";

  const updated = await AuditChecklist.findByIdAndUpdate(params.id, update, { new: true }).lean();
  if (!updated) return Response.json({ error: "Not found." }, { status: 404 });

  return Response.json({
    id: updated._id.toString(),
    heading: updated.heading,
    description: updated.description,
    order: updated.order,
  });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "super-admin") return Response.json({ error: "Forbidden" }, { status: 403 });

  await connectDB();
  await AuditChecklist.findByIdAndDelete(params.id);
  return Response.json({ success: true });
}
