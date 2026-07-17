import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, WeeklyReport, Group } from "@/lib/mongodb";

export const dynamic = "force-dynamic";

interface ReportShape {
  _id: { toString(): string };
  userId: string;
  userName: string;
  websiteId: string;
  websiteName: string;
  weekStart: string;
  clicks: number;
  impressions: number;
  indexation: number;
  rfqs: number;
  createdAt: Date;
}

function toRow(r: ReportShape) {
  return {
    id:          r._id.toString(),
    userId:      r.userId,
    userName:    r.userName,
    websiteId:   r.websiteId,
    websiteName: r.websiteName,
    weekStart:   r.weekStart,
    clicks:      r.clicks      ?? 0,
    impressions: r.impressions ?? 0,
    indexation:  r.indexation  ?? 0,
    rfqs:        r.rfqs        ?? 0,
    createdAt:   r.createdAt.toISOString(),
  };
}

// GET /api/weekly-reports
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const role = session.user.role;
  const myId = session.user.id;

  await connectDB();

  const filter: Record<string, unknown> = {};

  if (role === "admin") {
    filter.userId = myId;
  } else if (role === "sub-lead") {
    const group = await Group.findOne({ leadUserId: myId }).lean();
    const memberIds = group ? group.memberUserIds.map((id) => id.toString()) : [];
    filter.userId = { $in: [myId, ...memberIds] };
  }
  // super-admin: no filter

  const rows = await WeeklyReport.find(filter).sort({ weekStart: -1 }).lean();
  return Response.json(rows.map((r) => toRow(r as unknown as ReportShape)));
}

// POST /api/weekly-reports
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role === "super-admin") return Response.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json();
  const { websiteId, websiteName, weekStart, clicks, impressions, indexation, rfqs } = body;

  if (!websiteId || !weekStart) {
    return Response.json({ error: "Website and week are required." }, { status: 400 });
  }

  await connectDB();

  // Upsert: if same user+website+week exists, update it
  const existing = await WeeklyReport.findOne({
    userId: session.user.id, websiteId, weekStart,
  });

  if (existing) {
    existing.clicks      = clicks      ?? 0;
    existing.impressions = impressions ?? 0;
    existing.indexation  = indexation  ?? 0;
    existing.rfqs        = rfqs        ?? 0;
    await existing.save();
    return Response.json(toRow(existing.toObject() as unknown as ReportShape));
  }

  const created = await WeeklyReport.create({
    userId:      session.user.id,
    userName:    session.user.name ?? "",
    websiteId,
    websiteName,
    weekStart,
    clicks:      clicks      ?? 0,
    impressions: impressions ?? 0,
    indexation:  indexation  ?? 0,
    rfqs:        rfqs        ?? 0,
  });

  return Response.json(toRow(created.toObject() as unknown as ReportShape), { status: 201 });
}
