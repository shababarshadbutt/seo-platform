import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, Backlink, BacklinkSite } from "@/lib/mongodb";

export const dynamic = "force-dynamic";

// GET /api/backlinks — filtered list with pagination
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const search         = searchParams.get("search")?.trim() ?? "";
  const websiteName    = searchParams.get("websiteName")?.trim() ?? "";
  const type           = searchParams.get("type")?.trim() ?? "";
  const status         = searchParams.get("status")?.trim() ?? "";
  const approvalStatus = searchParams.get("approvalStatus")?.trim() ?? "";
  const userId         = searchParams.get("userId")?.trim() ?? "";
  const from           = searchParams.get("from")?.trim() ?? "";
  const to             = searchParams.get("to")?.trim() ?? "";
  const page           = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const limit          = 20;

  await connectDB();

  const filter: Record<string, unknown> = {};

  if (userId)         filter.userId = userId;
  if (websiteName)    filter.websiteName = { $regex: websiteName, $options: "i" };
  if (type)           filter.type = type;
  if (status)         filter.status = status;
  if (approvalStatus) filter.approvalStatus = approvalStatus;

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

  if (search) {
    filter.$or = [
      { websiteName:  { $regex: search, $options: "i" } },
      { backlinkUrl:  { $regex: search, $options: "i" } },
      { sourceSiteUrl: { $regex: search, $options: "i" } },
      { anchorText:   { $regex: search, $options: "i" } },
    ];
  }

  const [rows, total] = await Promise.all([
    Backlink.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Backlink.countDocuments(filter),
  ]);

  return Response.json({
    backlinks: rows.map((b) => ({
      id:              b._id.toString(),
      userId:          b.userId,
      userName:        b.userName,
      websiteName:     b.websiteName,
      targetUrl:       b.targetUrl ?? "",
      backlinkUrl:     b.backlinkUrl,
      anchorText:      b.anchorText ?? "",
      type:            b.type,
      da:              b.da ?? null,
      status:          b.status,
      notes:           b.notes ?? "",
      sourceSiteId:    b.sourceSiteId ?? "",
      sourceSiteUrl:   b.sourceSiteUrl ?? "",
      targetWebsiteId: b.targetWebsiteId ?? "",
      approvalStatus:  b.approvalStatus ?? "",
      rejectionReason: b.rejectionReason ?? "",
      rejectedByName:  (b as unknown as Record<string, unknown>).rejectedByName as string ?? "",
      createdAt:       b.createdAt.toISOString(),
    })),
    total,
    page,
    pages: Math.ceil(total / limit),
  });
}

// POST /api/backlinks — new workflow: one backlink per source site + target website
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role === "super-admin") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const { targetWebsiteId, websiteName, sourceSiteId, backlinkUrl, type, date } = body;

  if (!websiteName?.trim()) {
    return Response.json({ error: "Target website is required." }, { status: 400 });
  }
  if (!sourceSiteId) {
    return Response.json({ error: "Source site is required." }, { status: 400 });
  }
  if (!backlinkUrl?.trim()) {
    return Response.json({ error: "Backlink URL is required." }, { status: 400 });
  }

  await connectDB();

  // Fetch source site URL
  const sourceSite = await BacklinkSite.findById(sourceSiteId).lean();
  if (!sourceSite) {
    return Response.json({ error: "Source site not found." }, { status: 404 });
  }

  // Unique check: block if an active (pending/approved) backlink already exists for this pair
  // Skip check for reusable sites — they allow multiple backlinks across websites
  const isReusable = !!(sourceSite as unknown as Record<string, unknown>).reusable;
  if (!isReusable) {
    const duplicate = await Backlink.findOne({
      sourceSiteId,
      targetWebsiteId: targetWebsiteId ?? "",
      approvalStatus: { $in: ["pending", "approved"] },
    });
    if (duplicate) {
      return Response.json({
        error: `A backlink from "${sourceSite.url}" to "${websiteName}" is already pending or approved.`,
      }, { status: 409 });
    }
  }

  const created = await Backlink.create({
    userId:          session.user.id,
    userName:        session.user.name ?? "",
    userEmail:       session.user.email ?? "",
    websiteName:     websiteName.trim(),
    targetUrl:       "",
    backlinkUrl:     backlinkUrl.trim(),
    anchorText:      "",
    type:            type ?? "other",
    da:              null,
    status:          "live",
    notes:           "",
    sourceSiteId,
    sourceSiteUrl:   sourceSite.url,
    targetWebsiteId: targetWebsiteId ?? "",
    approvalStatus:  "pending",
    rejectionReason: "",
    createdAt:       date ? new Date(date) : new Date(),
  });

  return Response.json({
    id:              created._id.toString(),
    userId:          created.userId,
    userName:        created.userName,
    websiteName:     created.websiteName,
    targetUrl:       created.targetUrl,
    backlinkUrl:     created.backlinkUrl,
    anchorText:      created.anchorText,
    type:            created.type,
    da:              created.da,
    status:          created.status,
    notes:           created.notes,
    sourceSiteId:    created.sourceSiteId,
    sourceSiteUrl:   created.sourceSiteUrl,
    targetWebsiteId: created.targetWebsiteId,
    approvalStatus:  created.approvalStatus,
    rejectionReason: created.rejectionReason,
    createdAt:       created.createdAt.toISOString(),
  }, { status: 201 });
}
