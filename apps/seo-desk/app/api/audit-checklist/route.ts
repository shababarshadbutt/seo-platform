import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, AuditChecklist } from "@/lib/mongodb";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  await connectDB();
  const points = await AuditChecklist.find().sort({ order: 1 }).lean();

  return Response.json(
    points.map((p) => ({
      id: p._id.toString(),
      heading: p.heading,
      description: p.description,
      order: p.order,
    }))
  );
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "super-admin") return Response.json({ error: "Forbidden" }, { status: 403 });

  const { heading, description } = await req.json();
  if (!heading?.trim()) return Response.json({ error: "Heading is required." }, { status: 400 });

  await connectDB();
  const last = await AuditChecklist.findOne().sort({ order: -1 }).lean();
  const order = last ? last.order + 1 : 0;

  const point = await AuditChecklist.create({
    heading: heading.trim(),
    description: description?.trim() ?? "",
    order,
  });

  return Response.json(
    { id: point._id.toString(), heading: point.heading, description: point.description, order: point.order },
    { status: 201 }
  );
}
