import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, Website, IndexingQueue } from "@/lib/mongodb";

const PAGE_SIZE = 50;

export async function GET(req: Request, { params }: { params: { websiteId: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "super-admin") return Response.json({ error: "Forbidden" }, { status: 403 });

  const { websiteId } = params;
  const reqUrl = new URL(req.url);
  const page       = Math.max(1, parseInt(reqUrl.searchParams.get("page") ?? "1"));
  const gscStatus  = reqUrl.searchParams.get("gscStatus")  ?? "all";
  const bingStatus = reqUrl.searchParams.get("bingStatus") ?? "all";
  const search     = reqUrl.searchParams.get("search")?.trim() ?? "";

  await connectDB();

  const filter: Record<string, unknown> = { websiteId };
  if (gscStatus  !== "all") filter.gscStatus  = gscStatus;
  if (bingStatus !== "all") filter.bingStatus = bingStatus;
  if (search) filter.url = { $regex: search, $options: "i" };

  const [total, urls, website] = await Promise.all([
    IndexingQueue.countDocuments(filter),
    IndexingQueue.find(filter)
      .sort({ discoveredAt: -1 })
      .skip((page - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .lean(),
    Website.findById(websiteId).lean(),
  ]);

  const raw = website as unknown as Record<string, unknown> | null;

  return Response.json({
    website: website ? {
      id:           website._id.toString(),
      name:         website.name,
      url:          website.url ?? "",
      sitemapCount: ((raw?.sitemaps as unknown[]) ?? []).length,
      sitemaps:     ((raw?.sitemaps as { url: string; discoveredAt?: string }[]) ?? []).map((s) => ({
        url: s.url,
        discoveredAt: s.discoveredAt ?? null,
      })),
    } : null,
    urls: urls.map((u) => ({
      id:             u._id.toString(),
      url:            u.url,
      discoveredAt:   u.discoveredAt?.toISOString() ?? null,
      gscStatus:      u.gscStatus,
      gscSubmittedAt: u.gscSubmittedAt?.toISOString() ?? null,
      gscError:       u.gscError ?? null,
      bingStatus:     u.bingStatus,
      bingSubmittedAt: u.bingSubmittedAt?.toISOString() ?? null,
      bingError:      u.bingError ?? null,
    })),
    pagination: {
      page,
      pageSize:   PAGE_SIZE,
      total,
      totalPages: Math.ceil(total / PAGE_SIZE),
    },
  });
}
