import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, AuditChecklist } from "@/lib/mongodb";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "super-admin") return Response.json({ error: "Forbidden" }, { status: 403 });

  const items: { id: string; order: number }[] = await req.json();
  await connectDB();

  await Promise.all(
    items.map(({ id, order }) => AuditChecklist.findByIdAndUpdate(id, { order }))
  );

  return Response.json({ success: true });
}
