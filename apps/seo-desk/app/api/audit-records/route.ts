import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, AuditRecord, Group } from "@/lib/mongodb";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  await connectDB();

  const role = session.user.role;
  const myId = session.user.id;
  const filter: Record<string, unknown> = {};

  if (role === "admin") {
    filter.submittedBy = myId;
  } else if (role === "sub-lead") {
    const group = await Group.findOne({ leadUserId: myId }).lean();
    const memberIds = group ? group.memberUserIds.map((id) => id.toString()) : [];
    filter.submittedBy = { $in: [myId, ...memberIds] };
  }

  const records = await AuditRecord.find(filter).sort({ date: -1, createdAt: -1 }).lean();

  return Response.json(
    records.map((r) => ({
      id: r._id.toString(),
      websiteName: r.websiteName,
      websiteUrl: r.websiteUrl,
      submittedBy: r.submittedBy,
      submittedByName: r.submittedByName,
      date: r.date.toISOString(),
      results: r.results,
      createdAt: r.createdAt.toISOString(),
    }))
  );
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { websiteName, websiteUrl, date, results } = await req.json();

  if (!websiteName?.trim()) return Response.json({ error: "Website name is required." }, { status: 400 });
  if (!websiteUrl?.trim()) return Response.json({ error: "Website URL is required." }, { status: 400 });
  if (!date) return Response.json({ error: "Date is required." }, { status: 400 });
  if (!Array.isArray(results)) return Response.json({ error: "Results are required." }, { status: 400 });

  await connectDB();

  const record = await AuditRecord.create({
    websiteName: websiteName.trim(),
    websiteUrl: websiteUrl.trim(),
    submittedBy: session.user.id,
    submittedByName: session.user.name ?? "",
    date: new Date(date),
    results,
  });

  return Response.json(
    {
      id: record._id.toString(),
      websiteName: record.websiteName,
      websiteUrl: record.websiteUrl,
      submittedBy: record.submittedBy,
      submittedByName: record.submittedByName,
      date: record.date.toISOString(),
      results: record.results,
      createdAt: record.createdAt.toISOString(),
    },
    { status: 201 }
  );
}
