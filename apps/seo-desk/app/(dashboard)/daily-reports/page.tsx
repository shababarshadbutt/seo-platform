import { Suspense } from "react";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, DailyReport, Group, User } from "@/lib/mongodb";
import { ReportsClient, type DailyReportRow } from "./reports-client";

export default async function DailyReportsPage() {
  const session = await getServerSession(authOptions);
  const role = session!.user.role;
  const myId = session!.user.id;

  await connectDB();

  const filter: Record<string, unknown> = {};
  const members: { id: string; name: string }[] = [];

  if (role === "super-admin") {
    const allUsers = await User.find({}, "id name").lean();
    allUsers.forEach((u) => members.push({ id: u._id.toString(), name: u.name }));
  } else if (role === "sub-lead") {
    const group = await Group.findOne({ leadUserId: myId }).lean();
    const memberIds = group ? group.memberUserIds.map((id) => id.toString()) : [];
    filter.userId = { $in: [myId, ...memberIds] };
    if (memberIds.length > 0) {
      const groupUsers = await User.find({ _id: { $in: [myId, ...memberIds] } }, "id name").lean();
      groupUsers.forEach((u) => members.push({ id: u._id.toString(), name: u.name }));
    }
  } else {
    filter.userId = myId;
  }

  const raw = await DailyReport.find(filter).sort({ date: -1, createdAt: -1 }).lean();

  const reports: DailyReportRow[] = raw.map((r) => ({
    id:        r._id.toString(),
    userId:    r.userId,
    userName:  r.userName,
    date:      r.date.toISOString(),
    report:    r.report,
    type:      (r.type ?? "report") as "report" | "leave" | "public-holiday",
    createdAt: r.createdAt.toISOString(),
  }));

  return (
    <Suspense>
      <ReportsClient
        reports={reports}
        currentUserId={myId}
        viewerRole={role}
        members={members}
      />
    </Suspense>
  );
}
