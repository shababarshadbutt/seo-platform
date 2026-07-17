import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, Backlink, Group } from "@/lib/mongodb";

export const dynamic = "force-dynamic";

const TYPE_LABELS: Record<string, string> = {
  "guest-post": "Guest Post",
  "directory": "Business Listing",
  "forum": "Profiles Creation",
  "social": "Social Bookmarks",
  "article": "Web 2.0",
  "comment": "UGC",
  "press-release": "Forum",
  "other": "Other",
};

function csvCell(value: string): string {
  return `"${(value ?? "").replace(/"/g, '""')}"`;
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "super-admin") return Response.json({ error: "Forbidden" }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const tab    = searchParams.get("tab")?.trim()    ?? "";
  const teamId = searchParams.get("teamId")?.trim() ?? "";
  const type   = searchParams.get("type")?.trim()   ?? "";
  const status = searchParams.get("status")?.trim() ?? "";
  const from   = searchParams.get("from")?.trim()   ?? "";
  const to     = searchParams.get("to")?.trim()     ?? "";

  await connectDB();

  const filter: Record<string, unknown> = {};

  if (teamId) {
    const group = await Group.findById(teamId).lean();
    if (group) {
      const memberIds = [group.leadUserId.toString(), ...group.memberUserIds.map((id) => id.toString())];
      filter.userId = { $in: memberIds };
    }
  } else if (tab) {
    filter.userId = tab;
  }

  if (type) filter.type = type;
  if (status) filter.status = status;

  if (from || to) {
    const dateFilter: Record<string, Date> = {};
    if (from) dateFilter.$gte = new Date(from);
    if (to) {
      const toDate = new Date(to);
      toDate.setHours(23, 59, 59, 999);
      dateFilter.$lte = toDate;
    }
    filter.createdAt = dateFilter;
  }

  const backlinks = await Backlink.find(filter).sort({ createdAt: -1 }).lean();

  const rows = [
    ["Member", "Website Name", "Backlink URL", "Type", "Status", "Date"].join(","),
    ...backlinks.map((b) => {
      const date = new Date(b.createdAt).toLocaleDateString("en-GB", {
        timeZone: "Asia/Karachi", day: "2-digit", month: "2-digit", year: "numeric",
      });
      return [
        csvCell(b.userName ?? ""),
        csvCell(b.websiteName ?? ""),
        csvCell(b.backlinkUrl ?? ""),
        csvCell(TYPE_LABELS[b.type] ?? b.type ?? ""),
        csvCell(b.status ?? ""),
        csvCell(date),
      ].join(",");
    }),
  ];

  const csv = rows.join("\n");
  const filename = `backlinks-${new Date().toISOString().slice(0, 10)}.csv`;

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
