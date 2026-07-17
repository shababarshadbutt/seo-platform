import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, ExecutionLog, Backlink, ContentTask, Group } from "@/lib/mongodb";
import { Badge } from "@/components/ui/badge";
import { Play, ScrollText, CheckCircle, XCircle } from "lucide-react";
import { OverviewFilters } from "./overview-filters";
import { cn } from "@/lib/utils";

type ContentTaskType = "landing-request" | "blog-request" | "landing-update" | "blog-publish";

const CONTENT_LABELS: Record<ContentTaskType, string> = {
  "landing-request": "Landing Pages Request",
  "blog-request":    "Blogs Request",
  "landing-update":  "Landing Pages Update",
  "blog-publish":    "Blogs Publish",
};

async function getUserFilter(role: string, myId: string): Promise<Record<string, unknown>> {
  if (role === "super-admin") return {};
  if (role === "sub-lead") {
    const group = await Group.findOne({ leadUserId: myId }).lean();
    const memberIds = group ? group.memberUserIds.map((id) => id.toString()) : [];
    return { userId: { $in: [myId, ...memberIds] } };
  }
  return { userId: myId };
}

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: { from?: string; to?: string };
}) {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login");
  const role = session.user.role;
  const myId = session.user.id;
  const { from, to } = searchParams;

  await connectDB();

  // Auto-fix stale "running" logs from server restarts / redeployments
  const staleThreshold = new Date(Date.now() - 10 * 60 * 1000);
  await ExecutionLog.updateMany(
    { status: "running", startedAt: { $lt: staleThreshold } },
    { $set: { status: "error", completedAt: new Date(), output: "Interrupted — server was restarted during execution." } }
  ).catch(() => { /* ignore write errors (e.g. storage limit exceeded) */ });

  const userFilter = await getUserFilter(role, myId);

  // Script filter includes optional date range
  const execFilter: Record<string, unknown> = { ...userFilter };
  if (from || to) {
    const df: Record<string, Date> = {};
    if (from) df.$gte = new Date(from);
    if (to) { const d = new Date(to); d.setHours(23, 59, 59, 999); df.$lte = d; }
    execFilter.startedAt = df;
  }

  // Fetch all stats in parallel
  const [execStats, blStats, contentStats] = await Promise.all([
    // ── Script executions ──
    Promise.all([
      ExecutionLog.countDocuments(execFilter),
      ExecutionLog.countDocuments({ ...execFilter, status: "success" }),
      ExecutionLog.countDocuments({ ...execFilter, status: "error" }),
      ExecutionLog.countDocuments({ ...execFilter, status: "running" }),
      ExecutionLog.find(execFilter).sort({ startedAt: -1 }).limit(10).lean(),
    ]),
    // ── Backlinks ──
    Promise.all([
      Backlink.countDocuments(userFilter),
      Backlink.countDocuments({ ...userFilter, status: "live" }),
      Backlink.countDocuments({ ...userFilter, status: "pending" }),
      Backlink.countDocuments({ ...userFilter, status: "broken" }),
    ]),
    // ── Content tasks (4 types × 3 statuses) ──
    Promise.all(
      (["landing-request", "blog-request", "landing-update", "blog-publish"] as ContentTaskType[]).map(
        async (type) => {
          const [pending, inProgress, done] = await Promise.all([
            ContentTask.countDocuments({ ...userFilter, taskType: type, status: "pending" }),
            ContentTask.countDocuments({ ...userFilter, taskType: type, status: "in-progress" }),
            ContentTask.countDocuments({ ...userFilter, taskType: type, status: "done" }),
          ]);
          return {
            type,
            label: CONTENT_LABELS[type],
            pending,
            inProgress,
            done,
            total: pending + inProgress + done,
          };
        }
      )
    ),
  ]);

  const [execTotal, execSuccess, execError, execRunning, recentRuns] = execStats;
  const [blTotal, blLive, blPending, blBroken] = blStats;
  const isFiltered = !!(from || to);

  const roleSubtitle =
    role === "super-admin" ? "Full admin access — viewing all team data." :
    role === "sub-lead"    ? "Supervisor view — viewing your team's data." :
                             "Your personal activity summary.";

  return (
    <div className="space-y-8">

      {/* ── Header ── */}
      <div>
        <h2 className="text-2xl font-bold">
          Welcome back, {session?.user?.name?.split(" ")[0]}
        </h2>
        <p className="text-muted-foreground text-sm mt-1">{roleSubtitle}</p>
      </div>

      {/* ── Script Executions ── */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Script Executions
          </h3>
          <Suspense>
            <OverviewFilters />
          </Suspense>
        </div>
        {isFiltered && (
          <p className="text-xs text-muted-foreground">
            Filtered{from ? ` from ${from}` : ""}{to ? ` to ${to}` : ""}
          </p>
        )}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {([
            { label: "Total Runs", value: execTotal,   icon: ScrollText,  color: "text-blue-600",   bg: "bg-blue-50 border-blue-200"     },
            { label: "Successful", value: execSuccess,  icon: CheckCircle, color: "text-green-600",  bg: "bg-green-50 border-green-200"   },
            { label: "Failed",     value: execError,    icon: XCircle,     color: "text-red-600",    bg: "bg-red-50 border-red-200"       },
            { label: "Running",    value: execRunning,  icon: Play,        color: "text-yellow-600", bg: "bg-yellow-50 border-yellow-200" },
          ] as const).map(({ label, value, icon: Icon, color, bg }) => (
            <div key={label} className={cn("rounded-lg border p-4", bg)}>
              <div className="flex items-center justify-between">
                <p className={cn("text-xs font-medium", color)}>{label}</p>
                <Icon className={cn("h-4 w-4", color)} />
              </div>
              <p className="mt-2 text-3xl font-bold">{value as number}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Backlinks ── */}
      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Backlinks
        </h3>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {([
            { label: "Total",   value: blTotal,   color: "text-blue-600",   bg: "bg-blue-50 border-blue-200"     },
            { label: "Live",    value: blLive,    color: "text-green-600",  bg: "bg-green-50 border-green-200"   },
            { label: "Pending", value: blPending, color: "text-yellow-600", bg: "bg-yellow-50 border-yellow-200" },
            { label: "Broken",  value: blBroken,  color: "text-red-600",    bg: "bg-red-50 border-red-200"       },
          ] as const).map(({ label, value, color, bg }) => (
            <div key={label} className={cn("rounded-lg border p-4", bg)}>
              <p className={cn("text-xs font-medium", color)}>{label}</p>
              <p className="mt-2 text-3xl font-bold">{value as number}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Content Tasks ── */}
      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Content Tasks
        </h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {contentStats.map((s) => (
            <div key={s.type} className="rounded-lg border bg-card p-4 shadow-sm">
              <div className="flex items-start justify-between gap-2 mb-3">
                <p className="font-medium text-sm leading-snug">{s.label}</p>
                <span className="text-2xl font-bold shrink-0">{s.total}</span>
              </div>
              <div className="flex gap-4 text-xs">
                <span className="text-yellow-700 font-medium">{s.pending} Pending</span>
                <span className="text-blue-700 font-medium">{s.inProgress} In Progress</span>
                <span className="text-green-700 font-medium">{s.done} Done</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Recent Script Runs ── */}
      <section>
        <div className="rounded-lg border bg-card shadow-sm">
          <div className="border-b px-4 py-3">
            <h3 className="font-semibold text-sm">
              {isFiltered ? "Filtered Script Runs" : "Recent Script Runs"}
            </h3>
          </div>
          {(recentRuns as { _id: { toString(): string }; scriptName: string; userName: string; startedAt: Date; status: string; durationMs?: number | null }[]).length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              {isFiltered ? "No runs in this date range." : "No executions yet."}
            </p>
          ) : (
            <div className="divide-y">
              {(recentRuns as { _id: { toString(): string }; scriptName: string; userName: string; startedAt: Date; status: string; durationMs?: number | null }[]).map((log) => (
                <div key={log._id.toString()} className="flex items-center justify-between px-4 py-3 text-sm">
                  <div>
                    <p className="font-medium">{log.scriptName}</p>
                    <p className="text-xs text-muted-foreground">
                      {role !== "admin" && `${log.userName} · `}
                      {new Date(log.startedAt).toLocaleString()}
                      {log.durationMs != null && (
                        <span className="ml-2 text-muted-foreground/60">
                          ({(log.durationMs / 1000).toFixed(1)}s)
                        </span>
                      )}
                    </p>
                  </div>
                  <Badge
                    variant={
                      log.status === "success"   ? "success" :
                      log.status === "error"     ? "destructive" : "warning"
                    }
                  >
                    {log.status}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

    </div>
  );
}
