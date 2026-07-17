import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, BacklinkSite } from "@/lib/mongodb";

export const dynamic = "force-dynamic";

// GET /api/backlink-sites — all authenticated users can see the pool
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  await connectDB();
  const sites = await BacklinkSite.find({}).sort({ createdAt: -1 }).lean();

  return Response.json(
    sites.map((s) => ({
      id:          s._id.toString(),
      url:         s.url,
      da:          s.da ?? null,
      spamScore:   s.spamScore ?? null,
      niche:       s.niche ?? "",
      notes:       s.notes ?? "",
      reusable:    !!(s as unknown as Record<string, unknown>).reusable,
      addedBy:     s.addedBy,
      addedByName: s.addedByName,
      createdAt:   s.createdAt.toISOString(),
    }))
  );
}

// POST /api/backlink-sites — sub-lead and super-admin only
// Accepts { urls: string[], da, spamScore, niche, notes } for bulk add
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const role = session.user.role;
  if (role !== "super-admin" && role !== "sub-lead") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  // Accept per-row sites array: [{ url, da?, spamScore? }] + shared niche/notes
  const { sites, niche, notes } = body as {
    sites: Array<{ url: string; da?: string | number; spamScore?: string | number; reusable?: boolean }>;
    niche?: string;
    notes?: string;
  };

  if (!Array.isArray(sites) || sites.length === 0) {
    return Response.json({ error: "At least one site is required." }, { status: 400 });
  }

  const cleanSites = sites.map((s) => ({ ...s, url: String(s.url).trim() })).filter((s) => s.url);
  if (cleanSites.length === 0) {
    return Response.json({ error: "At least one valid URL is required." }, { status: 400 });
  }

  await connectDB();

  const nicheVal    = niche?.trim() ?? "";
  const notesVal    = notes?.trim() ?? "";
  const addedBy     = session.user.id;
  const addedByName = session.user.name ?? "";

  const created = await BacklinkSite.insertMany(
    cleanSites.map((s) => ({
      url:       s.url,
      da:        s.da != null && s.da !== "" ? Number(s.da) : null,
      spamScore: s.spamScore != null && s.spamScore !== "" ? Number(s.spamScore) : null,
      niche:     nicheVal,
      notes:     notesVal,
      reusable:  !!s.reusable,
      addedBy,
      addedByName,
    }))
  );

  // Force-write reusable flag via raw MongoDB to bypass any Mongoose schema caching issues
  const reusableIds = created
    .map((d, i) => ({ id: d._id, reusable: !!cleanSites[i].reusable }))
    .filter((x) => x.reusable)
    .map((x) => x.id);
  if (reusableIds.length > 0) {
    await BacklinkSite.collection.updateMany(
      { _id: { $in: reusableIds } },
      { $set: { reusable: true } }
    );
  }

  return Response.json(
    created.map((s, i) => ({
      id:          s._id.toString(),
      url:         s.url,
      da:          s.da ?? null,
      spamScore:   s.spamScore ?? null,
      niche:       s.niche ?? "",
      notes:       s.notes ?? "",
      reusable:    !!cleanSites[i].reusable,
      addedBy:     s.addedBy,
      addedByName: s.addedByName,
      createdAt:   s.createdAt.toISOString(),
    })),
    { status: 201 }
  );
}
