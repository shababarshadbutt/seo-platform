import { Suspense } from "react";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, ExecutionLog, User, Group } from "@/lib/mongodb";
import { LogsPageClient, type LogRow, type UserTab, type GroupTab } from "./logs-client";

const PAGE_SIZE = 15;

function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split("T")[0];
}

export default async function LogsPage({
  searchParams,
}: {
  searchParams: Record<string, string>;
}) {
  const session = await getServerSession(authOptions);
  const role = session!.user.role;
  const myId = session!.user.id;

  await connectDB();

  // Auto-fix stale "running" logs left over from server restarts / redeployments.
  const staleThreshold = new Date(Date.now() - 10 * 60 * 1000);
  await ExecutionLog.updateMany(
    { status: "running", startedAt: { $lt: staleThreshold } },
    { $set: { status: "error", completedAt: new Date(), output: "Interrupted — server was restarted during execution." } }
  );

  // Determine which user IDs this viewer can see
  let visibleUserIds: string[] | null = null; // null = all users (super-admin)

  if (role === "sub-lead") {
    const group = await Group.findOne({ leadUserId: myId }).lean();
    const memberIds = group ? group.memberUserIds.map((id) => id.toString()) : [];
    visibleUserIds = [myId, ...memberIds];
  } else if (role === "admin") {
    visibleUserIds = [myId];
  }

  // Build user list for filter dropdown
  let rawUsers;
  if (visibleUserIds === null) {
    rawUsers = await User.find({ isActive: true }).sort({ name: 1 }).lean();
  } else {
    rawUsers = await User.find({ _id: { $in: visibleUserIds }, isActive: true })
      .sort({ name: 1 })
      .lean();
  }

  const users: UserTab[] = rawUsers.map((u) => ({
    id: u._id.toString(),
    name: u.name,
    email: u.email,
    role: u.role,
  }));

  const selectedUserId = searchParams.userId ?? "";
  const selectedTeamId = searchParams.teamId ?? "";
  const runType        = (searchParams.runType ?? "all") as "all" | "manual" | "automated";
  const from = searchParams.from ?? yesterdayStr();
  const to   = searchParams.to   ?? yesterdayStr();
  const page = Math.max(1, parseInt(searchParams.page ?? "1", 10));

  // Fetch groups for super-admin team filter
  let groups: GroupTab[] = [];
  if (role === "super-admin") {
    const rawGroups = await Group.find({}).sort({ name: 1 }).lean();
    groups = rawGroups.map((g) => ({
      id: g._id.toString(),
      name: g.name,
      memberUserIds: [g.leadUserId.toString(), ...g.memberUserIds.map((id) => id.toString())],
    }));
  }

  const filter: Record<string, unknown> = {};

  // runType filter
  if (runType === "automated") {
    filter.isAutomated = true;
    // don't apply userId/teamId filter for automated logs (they have no userId)
  } else if (runType === "manual") {
    filter.isAutomated = { $ne: true };
    // apply normal visibility scope
    if (visibleUserIds !== null) {
      if (selectedUserId && visibleUserIds.includes(selectedUserId)) {
        filter.userId = selectedUserId;
      } else {
        filter.userId = { $in: visibleUserIds };
      }
    } else if (selectedTeamId) {
      const team = groups.find((g) => g.id === selectedTeamId);
      if (team) filter.userId = { $in: team.memberUserIds };
    } else if (selectedUserId) {
      filter.userId = selectedUserId;
    }
  } else {
    // "all" — apply visibility scope (automated logs have null userId so they
    // only appear for super-admin with no user filter)
    if (visibleUserIds !== null) {
      if (selectedUserId && visibleUserIds.includes(selectedUserId)) {
        filter.userId = selectedUserId;
      } else {
        filter.userId = { $in: visibleUserIds };
      }
    } else if (selectedTeamId) {
      const team = groups.find((g) => g.id === selectedTeamId);
      if (team) filter.userId = { $in: team.memberUserIds };
    } else if (selectedUserId) {
      filter.userId = selectedUserId;
    }
  }

  if (from || to) {
    const dateFilter: Record<string, Date> = {};
    if (from) dateFilter.$gte = new Date(from);
    if (to) {
      const toDate = new Date(to);
      toDate.setHours(23, 59, 59, 999);
      dateFilter.$lte = toDate;
    }
    filter.startedAt = dateFilter;
  }

  const [rawLogs, total, successCount, errorCount] = await Promise.all([
    ExecutionLog.find(filter)
      .sort({ startedAt: -1 })
      .skip((page - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .lean(),
    ExecutionLog.countDocuments(filter),
    ExecutionLog.countDocuments({ ...filter, status: "success" }),
    ExecutionLog.countDocuments({ ...filter, status: "error" }),
  ]);

  const logs: LogRow[] = rawLogs.map((l) => {
    const raw = l as unknown as Record<string, unknown>;
    return {
      id:          l._id.toString(),
      scriptName:  l.scriptName,
      scriptSlug:  l.scriptSlug,
      userName:    l.userName,
      userEmail:   l.userEmail,
      status:      l.status as LogRow["status"],
      exitCode:    l.exitCode ?? null,
      startedAt:   l.startedAt.toISOString(),
      durationMs:  l.durationMs ?? null,
      output:      l.output ?? "",
      isAutomated: !!(raw.isAutomated),
      websiteId:   (raw.websiteId as string) ?? null,
      websiteName: (raw.websiteName as string) ?? null,
    };
  });

  return (
    <Suspense>
      <LogsPageClient
        users={users}
        selectedUserId={selectedUserId}
        selectedTeamId={selectedTeamId}
        groups={groups}
        logs={logs}
        stats={{ total, success: successCount, error: errorCount }}
        from={from}
        to={to}
        page={page}
        total={total}
        pageSize={PAGE_SIZE}
        currentAdminId={myId}
        viewerRole={role}
        runType={runType}
      />
    </Suspense>
  );
}
