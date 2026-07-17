import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, Website, IndexingQueue } from "@/lib/mongodb";

export const dynamic = "force-dynamic";

// GET /api/automation/stats — per-website queue stats (super-admin only)
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "super-admin") return Response.json({ error: "Forbidden" }, { status: 403 });

  await connectDB();

  const websites = await Website.find({}).lean();

  const stats = await Promise.all(
    websites.map(async (w) => {
      const id = w._id.toString();
      const raw = w as unknown as Record<string, unknown>;
      const [gscPending, gscSubmitted, gscFailed, bingPending, bingSubmitted, bingFailed] =
        await Promise.all([
          IndexingQueue.countDocuments({ websiteId: id, gscStatus:  "pending" }),
          IndexingQueue.countDocuments({ websiteId: id, gscStatus:  "submitted" }),
          IndexingQueue.countDocuments({ websiteId: id, gscStatus:  "failed" }),
          IndexingQueue.countDocuments({ websiteId: id, bingStatus: "pending" }),
          IndexingQueue.countDocuments({ websiteId: id, bingStatus: "submitted" }),
          IndexingQueue.countDocuments({ websiteId: id, bingStatus: "failed" }),
        ]);

      return {
        id,
        name:              w.name,
        url:               w.url ?? "",
        automationEnabled: !!(raw.automationEnabled),
        gsc:  { pending: gscPending,  submitted: gscSubmitted,  failed: gscFailed },
        bing: { pending: bingPending, submitted: bingSubmitted, failed: bingFailed },
      };
    })
  );

  return Response.json(stats.filter((s) => s.automationEnabled || s.gsc.submitted + s.bing.submitted > 0));
}
