import { Suspense } from "react";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, WeeklyReport, Website, Group, User } from "@/lib/mongodb";
import { WeeklyReportsClient, type WeeklyReportRow, type AssignedWebsite, type MemberOption } from "./weekly-reports-client";

export default async function WeeklyReportsPage() {
  const session = await getServerSession(authOptions);
  const role = session!.user.role;
  const myId = session!.user.id;

  await connectDB();

  // Assigned websites for submission form (non-super-admin)
  const assignedWebsites: AssignedWebsite[] = [];
  if (role !== "super-admin") {
    const myWebsites = await Website.find({ "assignedTo.userId": myId }).sort({ name: 1 }).lean();
    myWebsites.forEach((w) => assignedWebsites.push({ id: w._id.toString(), name: w.name }));
  }

  // Members for filter dropdown
  const members: MemberOption[] = [];
  if (role === "super-admin") {
    const users = await User.find({ isActive: true, role: { $ne: "super-admin" } }).sort({ name: 1 }).lean();
    users.forEach((u) => members.push({ id: u._id.toString(), name: u.name }));
  } else if (role === "sub-lead") {
    const group = await Group.findOne({ leadUserId: myId }).lean();
    const memberIds = group ? group.memberUserIds.map((id) => id.toString()) : [];
    const allIds = [myId, ...memberIds];
    const users = await User.find({ _id: { $in: allIds }, isActive: true }).sort({ name: 1 }).lean();
    users.forEach((u) => members.push({ id: u._id.toString(), name: u.name }));
  }

  // Fetch reports
  const filter: Record<string, unknown> = {};
  if (role === "admin") {
    filter.userId = myId;
  } else if (role === "sub-lead") {
    const group = await Group.findOne({ leadUserId: myId }).lean();
    const memberIds = group ? group.memberUserIds.map((id) => id.toString()) : [];
    filter.userId = { $in: [myId, ...memberIds] };
  }

  const raw = await WeeklyReport.find(filter).sort({ weekStart: -1 }).lean();

  const reports: WeeklyReportRow[] = raw.map((r) => ({
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
  }));

  return (
    <Suspense>
      <WeeklyReportsClient
        reports={reports}
        assignedWebsites={assignedWebsites}
        members={members}
        viewerRole={role}
        currentUserId={myId}
      />
    </Suspense>
  );
}
