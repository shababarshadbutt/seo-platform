import { redirect } from "next/navigation";
import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, Website, IndexingQueue } from "@/lib/mongodb";

export default async function IndexingQueuePage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login");
  if (session.user.role !== "super-admin") redirect("/");

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

  const rows = websites.map((w) => {
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
      ...s,
    };
  });

  // Grand totals
  const totals = rows.reduce(
    (acc, r) => ({
      total:         acc.total         + r.total,
      gscPending:    acc.gscPending    + r.gscPending,
      gscSubmitted:  acc.gscSubmitted  + r.gscSubmitted,
      gscFailed:     acc.gscFailed     + r.gscFailed,
      bingPending:   acc.bingPending   + r.bingPending,
      bingSubmitted: acc.bingSubmitted + r.bingSubmitted,
      bingFailed:    acc.bingFailed    + r.bingFailed,
    }),
    { total: 0, gscPending: 0, gscSubmitted: 0, gscFailed: 0, bingPending: 0, bingSubmitted: 0, bingFailed: 0 }
  );

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Indexing Queue</h1>
        <p className="text-sm text-gray-500 mt-1">{rows.length} automated website(s)</p>
      </div>

      {/* Grand total summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <SummaryCard label="Total URLs" value={totals.total} color="gray" />
        <SummaryCard label="GSC Submitted" value={totals.gscSubmitted} color="green" />
        <SummaryCard label="GSC Pending" value={totals.gscPending} color="yellow" />
        <SummaryCard label="GSC Failed" value={totals.gscFailed} color="red" />
        <SummaryCard label="Bing Submitted" value={totals.bingSubmitted} color="green" />
        <SummaryCard label="Bing Pending" value={totals.bingPending} color="yellow" />
        <SummaryCard label="Bing Failed" value={totals.bingFailed} color="red" />
      </div>

      {/* Website table */}
      {rows.length === 0 ? (
        <p className="text-sm text-gray-500">No automation-enabled websites found.</p>
      ) : (
        <div className="rounded-lg border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Website</th>
                <th className="text-center px-3 py-3 font-medium text-gray-600">Sitemaps</th>
                <th className="text-center px-3 py-3 font-medium text-gray-600">Total URLs</th>
                <th className="text-center px-3 py-3 font-medium text-gray-600 bg-green-50">GSC ✓</th>
                <th className="text-center px-3 py-3 font-medium text-gray-600 bg-yellow-50">GSC ⏳</th>
                <th className="text-center px-3 py-3 font-medium text-gray-600 bg-red-50">GSC ✗</th>
                <th className="text-center px-3 py-3 font-medium text-gray-600 bg-green-50">Bing ✓</th>
                <th className="text-center px-3 py-3 font-medium text-gray-600 bg-yellow-50">Bing ⏳</th>
                <th className="text-center px-3 py-3 font-medium text-gray-600 bg-red-50">Bing ✗</th>
                <th className="px-3 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((row) => (
                <tr key={row.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900">{row.name}</div>
                    <div className="text-xs text-gray-400 truncate max-w-xs">{row.url}</div>
                  </td>
                  <td className="px-3 py-3 text-center text-gray-700">{row.sitemapCount}</td>
                  <td className="px-3 py-3 text-center font-medium text-gray-900">{row.total.toLocaleString()}</td>
                  <td className="px-3 py-3 text-center text-green-700 bg-green-50/40">{row.gscSubmitted.toLocaleString()}</td>
                  <td className="px-3 py-3 text-center text-yellow-700 bg-yellow-50/40">{row.gscPending.toLocaleString()}</td>
                  <td className="px-3 py-3 text-center text-red-700 bg-red-50/40">{row.gscFailed.toLocaleString()}</td>
                  <td className="px-3 py-3 text-center text-green-700 bg-green-50/40">{row.bingSubmitted.toLocaleString()}</td>
                  <td className="px-3 py-3 text-center text-yellow-700 bg-yellow-50/40">{row.bingPending.toLocaleString()}</td>
                  <td className="px-3 py-3 text-center text-red-700 bg-red-50/40">{row.bingFailed.toLocaleString()}</td>
                  <td className="px-3 py-3 text-right">
                    <Link
                      href={`/indexing-queue/${row.id}`}
                      className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 transition-colors"
                    >
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, color }: { label: string; value: number; color: "gray" | "green" | "yellow" | "red" }) {
  const colorClass = {
    gray:   "bg-gray-50 text-gray-900",
    green:  "bg-green-50 text-green-800",
    yellow: "bg-yellow-50 text-yellow-800",
    red:    "bg-red-50 text-red-800",
  }[color];

  return (
    <div className={`rounded-lg border border-gray-200 px-4 py-3 ${colorClass}`}>
      <div className="text-xl font-bold">{value.toLocaleString()}</div>
      <div className="text-xs mt-0.5 opacity-70">{label}</div>
    </div>
  );
}
