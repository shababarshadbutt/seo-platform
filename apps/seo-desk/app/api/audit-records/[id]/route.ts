import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, AuditRecord } from "@/lib/mongodb";

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  await connectDB();
  const record = await AuditRecord.findById(params.id);
  if (!record) return Response.json({ error: "Not found." }, { status: 404 });

  const isOwner = record.submittedBy === session.user.id;
  const isSuperAdmin = session.user.role === "super-admin";

  if (!isOwner && !isSuperAdmin) {
    return Response.json({ error: "Forbidden." }, { status: 403 });
  }

  await AuditRecord.findByIdAndDelete(params.id);
  return Response.json({ success: true });
}
