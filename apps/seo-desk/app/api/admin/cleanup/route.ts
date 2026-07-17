import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, Website, IndexingQueue } from "@/lib/mongodb";

// POST /api/admin/cleanup
// Clears entire indexing queue + disables automation on all websites.
// Super-admin only. One-time emergency use.
export async function POST() {
  try {
    const session = await getServerSession(authOptions);
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (session.user.role !== "super-admin") return Response.json({ error: "Forbidden" }, { status: 403 });

    await connectDB();

    const [queueResult, websiteResult] = await Promise.all([
      IndexingQueue.deleteMany({}),
      Website.updateMany({}, { $set: { automationEnabled: false } }),
    ]);

    return Response.json({
      queueDeleted:     queueResult.deletedCount,
      websitesDisabled: websiteResult.modifiedCount,
    });
  } catch (err) {
    console.error("[CLEANUP] Error:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
