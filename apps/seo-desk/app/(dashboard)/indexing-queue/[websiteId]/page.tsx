import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, Website, IndexingQueue } from "@/lib/mongodb";
import { QueueClient } from "./queue-client";

const PAGE_SIZE = 50;

export default async function WebsiteQueuePage({ params }: { params: { websiteId: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login");
  if (session.user.role !== "super-admin") redirect("/");

  const { websiteId } = params;

  await connectDB();

  const website = await Website.findById(websiteId).lean();
  if (!website) notFound();

  const raw = website as unknown as Record<string, unknown>;

  // Aggregate stats for this website
  const [stats] = await IndexingQueue.aggregate([
    { $match: { websiteId } },
    {
      $group: {
        _id: null,
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

  const s = stats ?? {
    total: 0, gscPending: 0, gscSubmitted: 0, gscFailed: 0,
    bingPending: 0, bingSubmitted: 0, bingFailed: 0,
  };

  // Initial URL page
  const total = await IndexingQueue.countDocuments({ websiteId });
  const initialUrls = await IndexingQueue.find({ websiteId })
    .sort({ discoveredAt: -1 })
    .limit(PAGE_SIZE)
    .lean();

  const sitemapRaw = (raw.sitemaps as { url: string; discoveredAt?: Date }[]) ?? [];

  const websiteInfo = {
    id:           website._id.toString(),
    name:         website.name,
    url:          website.url ?? "",
    sitemapCount: sitemapRaw.length,
    sitemaps:     sitemapRaw.map((s) => ({
      url: s.url,
      discoveredAt: s.discoveredAt ? new Date(s.discoveredAt).toISOString() : null,
    })),
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link
              href="/indexing-queue"
              className="text-sm text-gray-500 hover:text-gray-700 transition-colors"
            >
              ← Indexing Queue
            </Link>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">{website.name}</h1>
          <a
            href={website.url}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-blue-600 hover:underline"
          >
            {website.url}
          </a>
        </div>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
        <StatCard label="Total URLs"     value={s.total}         color="gray" />
        <StatCard label="GSC Submitted"  value={s.gscSubmitted}  color="green" />
        <StatCard label="GSC Pending"    value={s.gscPending}    color="yellow" />
        <StatCard label="GSC Failed"     value={s.gscFailed}     color="red" />
        <StatCard label="Bing Submitted" value={s.bingSubmitted} color="green" />
        <StatCard label="Bing Pending"   value={s.bingPending}   color="yellow" />
        <StatCard label="Bing Failed"    value={s.bingFailed}    color="red" />
      </div>

      {/* Client component: sitemaps, filters, URL table, pagination */}
      <QueueClient
        websiteId={websiteId}
        initialWebsite={websiteInfo}
        initialUrls={initialUrls.map((u) => ({
          id:              u._id.toString(),
          url:             u.url,
          discoveredAt:    u.discoveredAt?.toISOString() ?? null,
          gscStatus:       u.gscStatus,
          gscSubmittedAt:  u.gscSubmittedAt?.toISOString() ?? null,
          gscError:        u.gscError ?? null,
          bingStatus:      u.bingStatus,
          bingSubmittedAt: u.bingSubmittedAt?.toISOString() ?? null,
          bingError:       u.bingError ?? null,
        }))}
        initialPagination={{
          page:       1,
          pageSize:   PAGE_SIZE,
          total,
          totalPages: Math.ceil(total / PAGE_SIZE),
        }}
      />
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color: "gray" | "green" | "yellow" | "red" }) {
  const cls = {
    gray:   "bg-gray-50  text-gray-900",
    green:  "bg-green-50 text-green-800",
    yellow: "bg-yellow-50 text-yellow-800",
    red:    "bg-red-50   text-red-800",
  }[color];
  return (
    <div className={`rounded-lg border border-gray-200 px-4 py-3 ${cls}`}>
      <div className="text-xl font-bold">{value.toLocaleString()}</div>
      <div className="text-xs mt-0.5 opacity-70">{label}</div>
    </div>
  );
}
