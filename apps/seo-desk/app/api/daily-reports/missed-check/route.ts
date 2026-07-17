import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, DailyReport, User } from "@/lib/mongodb";

export const dynamic = "force-dynamic";

const PKT = "Asia/Karachi";

function todayPKT(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: PKT });
}

function toDateObj(str: string): Date {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function toDateStr(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Returns all working days (Mon–Fri) from startStr to endStr inclusive
function workingDaysBetween(startStr: string, endStr: string): string[] {
  const days: string[] = [];
  const current = toDateObj(startStr);
  const end = toDateObj(endStr);
  while (current <= end) {
    const dow = current.getDay();
    if (dow !== 0 && dow !== 6) days.push(toDateStr(current));
    current.setDate(current.getDate() + 1);
  }
  return days;
}

// GET /api/daily-reports/missed-check
// Returns { missedDate: string | null } — oldest missed working day in last 30 days
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  if (session.user.role === "super-admin") {
    return Response.json({ missedDate: null });
  }

  const today = todayPKT();
  const todayObj = toDateObj(today);

  // Yesterday (last possible day to have missed)
  const yesterday = new Date(todayObj);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = toDateStr(yesterday);

  await connectDB();

  // Start from whichever is later: April 22 2026 (global cutoff) or user's account creation date
  const GLOBAL_CUTOFF = "2026-04-22";
  const userDoc = await User.findById(session.user.id).select("createdAt").lean();
  const userCreatedStr = userDoc?.createdAt ? toDateStr(userDoc.createdAt) : GLOBAL_CUTOFF;
  const startStr = userCreatedStr > GLOBAL_CUTOFF ? userCreatedStr : GLOBAL_CUTOFF;

  const workingDays = workingDaysBetween(startStr, yesterdayStr);
  if (workingDays.length === 0) return Response.json({ missedDate: null });

  // Fetch all reports for this user in the range
  const rangeStart = new Date(workingDays[0] + "T00:00:00.000Z");
  const rangeEnd   = new Date(workingDays[workingDays.length - 1] + "T23:59:59.999Z");

  const reports = await DailyReport.find({
    userId: session.user.id,
    date: { $gte: rangeStart, $lte: rangeEnd },
  }).select("date").lean();

  const reportDates = new Set(reports.map((r) => r.date.toISOString().slice(0, 10)));

  // Return the oldest working day that has no report
  for (const day of workingDays) {
    if (!reportDates.has(day)) {
      return Response.json({ missedDate: day });
    }
  }

  return Response.json({ missedDate: null });
}
