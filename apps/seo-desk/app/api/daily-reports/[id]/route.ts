import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, DailyReport, Group } from "@/lib/mongodb";

async function canModify(reportUserId: string, role: string, myId: string): Promise<boolean> {
  if (role === "super-admin") return true;
  if (reportUserId === myId) return true;
  if (role === "sub-lead") {
    const group = await Group.findOne({ leadUserId: myId }).lean();
    if (group) return group.memberUserIds.map((id) => id.toString()).includes(reportUserId);
  }
  return false;
}

// PATCH /api/daily-reports/[id]
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  await connectDB();
  const existing = await DailyReport.findById(params.id);
  if (!existing) return Response.json({ error: "Not found." }, { status: 404 });

  if (!(await canModify(existing.userId, session.user.role, session.user.id))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();

  await DailyReport.updateOne(
    { _id: params.id },
    {
      $set: {
        ...(body.date   && { date:   new Date(body.date) }),
        ...(body.report && { report: body.report.trim() }),
      },
    }
  );

  const updated = await DailyReport.findById(params.id).lean();
  if (!updated) return Response.json({ error: "Not found." }, { status: 404 });

  return Response.json({
    id:        updated._id.toString(),
    userId:    updated.userId,
    userName:  updated.userName,
    date:      updated.date.toISOString(),
    report:    updated.report,
    type:      updated.type ?? "report",
    createdAt: updated.createdAt.toISOString(),
  });
}

// DELETE /api/daily-reports/[id]
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  await connectDB();
  const existing = await DailyReport.findById(params.id);
  if (!existing) return Response.json({ error: "Not found." }, { status: 404 });

  if (!(await canModify(existing.userId, session.user.role, session.user.id))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  await existing.deleteOne();
  return Response.json({ success: true });
}
