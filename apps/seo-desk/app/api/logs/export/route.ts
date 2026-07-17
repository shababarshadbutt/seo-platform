import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, ExecutionLog } from "@/lib/mongodb";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const isAdmin = session.user.role === "admin";

  // Build filter (same logic as the page)
  const filter: Record<string, unknown> = {};

  if (!isAdmin) {
    filter.userId = session.user.id;
  }

  const status = searchParams.get("status");
  const scriptSlug = searchParams.get("scriptSlug");
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  if (status) filter.status = status;
  if (scriptSlug) filter.scriptSlug = scriptSlug;
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

  await connectDB();

  const logs = await ExecutionLog.find(filter)
    .sort({ startedAt: -1 })
    .limit(10_000) // safety cap
    .lean();

  // Build CSV
  const adminColumns = isAdmin ? ["User", "Email"] : [];
  const headers = [
    ...adminColumns,
    "Script",
    "Status",
    "Exit Code",
    "Started At",
    "Completed At",
    "Duration (ms)",
  ];

  const rows = logs.map((l) => {
    const adminFields = isAdmin ? [csvEscape(l.userName), csvEscape(l.userEmail)] : [];
    return [
      ...adminFields,
      csvEscape(l.scriptName),
      csvEscape(l.status),
      l.exitCode ?? "",
      l.startedAt.toISOString(),
      l.completedAt ? l.completedAt.toISOString() : "",
      l.durationMs ?? "",
    ].join(",");
  });

  const csv = [headers.join(","), ...rows].join("\n");
  const filename = `asap-logs-${new Date().toISOString().split("T")[0]}.csv`;

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
