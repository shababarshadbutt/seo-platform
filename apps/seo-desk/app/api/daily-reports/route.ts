import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, DailyReport, Group } from "@/lib/mongodb";

export const dynamic = "force-dynamic";

// GET /api/daily-reports?from=&to=&userId=
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const role = session.user.role;
  const myId = session.user.id;
  const { searchParams } = new URL(req.url);

  await connectDB();

  const filter: Record<string, unknown> = {};

  // Role-based user filtering
  if (role === "super-admin") {
    const userId = searchParams.get("userId");
    if (userId) filter.userId = userId;
  } else if (role === "sub-lead") {
    const group = await Group.findOne({ leadUserId: myId }).lean();
    const memberIds = group ? group.memberUserIds.map((id) => id.toString()) : [];
    const allowedIds = [myId, ...memberIds];
    const userId = searchParams.get("userId");
    filter.userId = userId && allowedIds.includes(userId) ? userId : { $in: allowedIds };
  } else {
    filter.userId = myId;
  }

  // Date range
  const from = searchParams.get("from");
  const to   = searchParams.get("to");
  if (from || to) {
    const df: Record<string, Date> = {};
    if (from) df.$gte = new Date(from);
    if (to) { const d = new Date(to); d.setHours(23, 59, 59, 999); df.$lte = d; }
    filter.date = df;
  }

  const reports = await DailyReport.find(filter).sort({ date: -1, createdAt: -1 }).lean();

  return Response.json(
    reports.map((r) => ({
      id:        r._id.toString(),
      userId:    r.userId,
      userName:  r.userName,
      date:      r.date.toISOString(),
      report:    r.report,
      type:      r.type ?? "report",
      createdAt: r.createdAt.toISOString(),
    }))
  );
}

// POST /api/daily-reports
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { date, report, type } = body;
  const isLeave   = type === "leave";
  const isHoliday = type === "public-holiday";
  const noReport  = isLeave || isHoliday;

  if (!date) {
    return Response.json({ error: "Date is required." }, { status: 400 });
  }
  if (!noReport && !report?.trim()) {
    return Response.json({ error: "Report cannot be empty." }, { status: 400 });
  }

  await connectDB();

  const created = await DailyReport.create({
    userId:   session.user.id,
    userName: session.user.name ?? "",
    date:     new Date(date),
    report:   isLeave ? "On leave" : isHoliday ? "Public holiday" : report.trim(),
    type:     noReport ? type : "report",
  });

  return Response.json({
    id:        created._id.toString(),
    userId:    created.userId,
    userName:  created.userName,
    date:      created.date.toISOString(),
    report:    created.report,
    type:      created.type,
    createdAt: created.createdAt.toISOString(),
  }, { status: 201 });
}
