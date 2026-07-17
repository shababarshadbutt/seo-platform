import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, WeeklyReport } from "@/lib/mongodb";

// PATCH /api/weekly-reports/[id]
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  await connectDB();
  const report = await WeeklyReport.findById(params.id);
  if (!report) return Response.json({ error: "Not found." }, { status: 404 });

  const isOwner      = report.userId === session.user.id;
  const isSuperAdmin = session.user.role === "super-admin";
  if (!isOwner && !isSuperAdmin) return Response.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json();
  if (body.clicks      !== undefined) report.clicks      = body.clicks;
  if (body.impressions !== undefined) report.impressions = body.impressions;
  if (body.indexation  !== undefined) report.indexation  = body.indexation;
  if (body.rfqs        !== undefined) report.rfqs        = body.rfqs;

  await report.save();

  return Response.json({
    id:          report._id.toString(),
    userId:      report.userId,
    userName:    report.userName,
    websiteId:   report.websiteId,
    websiteName: report.websiteName,
    weekStart:   report.weekStart,
    clicks:      report.clicks,
    impressions: report.impressions,
    indexation:  report.indexation,
    rfqs:        report.rfqs,
    createdAt:   report.createdAt.toISOString(),
  });
}

// DELETE /api/weekly-reports/[id]
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  await connectDB();
  const report = await WeeklyReport.findById(params.id);
  if (!report) return Response.json({ error: "Not found." }, { status: 404 });

  const isOwner      = report.userId === session.user.id;
  const isSuperAdmin = session.user.role === "super-admin";
  if (!isOwner && !isSuperAdmin) return Response.json({ error: "Forbidden" }, { status: 403 });

  await report.deleteOne();
  return Response.json({ success: true });
}
