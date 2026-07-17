import { Suspense } from "react";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, AuditChecklist, AuditRecord, Group, User } from "@/lib/mongodb";
import { AuditClient, type ChecklistPoint, type AuditRecordRow } from "./audit-client";

export default async function AuditPage() {
  const session = await getServerSession(authOptions);
  const role = session!.user.role;
  const myId = session!.user.id;

  await connectDB();

  const rawPoints = await AuditChecklist.find().sort({ order: 1 }).lean();
  const checklistPoints: ChecklistPoint[] = rawPoints.map((p) => ({
    id: p._id.toString(),
    heading: p.heading,
    description: p.description,
    order: p.order,
  }));

  const filter: Record<string, unknown> = {};
  const members: { id: string; name: string }[] = [];

  if (role === "admin") {
    filter.submittedBy = myId;
  } else if (role === "sub-lead") {
    const group = await Group.findOne({ leadUserId: myId }).lean();
    const memberIds = group ? group.memberUserIds.map((id) => id.toString()) : [];
    filter.submittedBy = { $in: [myId, ...memberIds] };
    const groupUsers = await User.find({ _id: { $in: [myId, ...memberIds] } }, "name").lean();
    groupUsers.forEach((u) => members.push({ id: u._id.toString(), name: u.name }));
  } else {
    const allUsers = await User.find({}, "name").lean();
    allUsers.forEach((u) => members.push({ id: u._id.toString(), name: u.name }));
  }

  const rawRecords = await AuditRecord.find(filter).sort({ date: -1, createdAt: -1 }).lean();

  const records: AuditRecordRow[] = rawRecords.map((r) => ({
    id: r._id.toString(),
    websiteName: r.websiteName,
    websiteUrl: r.websiteUrl,
    submittedBy: r.submittedBy,
    submittedByName: r.submittedByName,
    date: r.date.toISOString(),
    results: r.results.map((res) => ({
      pointId: res.pointId,
      heading: res.heading,
      checked: res.checked,
      details: res.details,
    })),
    createdAt: r.createdAt.toISOString(),
  }));

  return (
    <Suspense>
      <AuditClient
        records={records}
        checklistPoints={checklistPoints}
        currentUserId={myId}
        viewerRole={role}
        members={members}
      />
    </Suspense>
  );
}
