import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, Website, IndexingQueue } from "@/lib/mongodb";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "super-admin") return Response.json({ error: "Forbidden" }, { status: 403 });

  await connectDB();

  const allWebsites = await Website.find({}).lean();
  const websites = allWebsites.filter(
    (w) => !!(w as unknown as Record<string, unknown>).automationEnabled
  );

  const stats = await IndexingQueue.aggregate([
    {
      $group: {
        _id: "$websiteId",
        total:         { $sum: 1 },
        gscPending:    { $sum: { $cond: [{ $eq: ["$gscStatus",  "pending"]   }, 1, 0] } },
        gscSubmitted:  { $sum: { $cond: [{ $eq: ["$gscStatus",  "submitted"] }, 1, 0] } },
        gscFailed:     { $sum: { $cond: [{ $eq: ["$gscStatus",  "failed"]    }, 1, 0] } },
        bingPending:   { $sum: { $cond: [{ $eq: ["$bingStatus", "pending"]   }, 1, 0] } },
        bingSubmitted: { $sum: { $cond: [{ $eq: ["$bingStatus", "submitted"] }, 1, 0] } },
        bingFailed:    { $sum: { $cond: [{ $eq: ["$bingStatus", "failed"]    }, 1, 0] } },
      },
    },
  ]);

  const statsMap = new Map(stats.map((s) => [s._id as string, s]));

  const result = websites.map((w) => {
    const raw = w as unknown as Record<string, unknown>;
    const s = statsMap.get(w._id.toString()) ?? {
      total: 0, gscPending: 0, gscSubmitted: 0, gscFailed: 0,
      bingPending: 0, bingSubmitted: 0, bingFailed: 0,
    };
    return {
      id:           w._id.toString(),
      name:         w.name,
      url:          w.url ?? "",
      sitemapCount: ((raw.sitemaps as unknown[]) ?? []).length,
      total:        s.total,
      gscPending:   s.gscPending,
      gscSubmitted: s.gscSubmitted,
      gscFailed:    s.gscFailed,
      bingPending:  s.bingPending,
      bingSubmitted: s.bingSubmitted,
      bingFailed:   s.bingFailed,
    };
  });

  return Response.json(result);
}
