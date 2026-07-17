import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, BacklinkSite } from "@/lib/mongodb";

// PATCH /api/backlink-sites/[id] — toggle reusable flag (sub-lead or super-admin)
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const role = session.user.role;
  if (role !== "super-admin" && role !== "sub-lead") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const reusableVal = !!body.reusable;
  await connectDB();

  // Use raw MongoDB $set to bypass Mongoose schema caching issues
  await BacklinkSite.collection.updateOne(
    { _id: new (await import("mongoose")).default.Types.ObjectId(params.id) },
    { $set: { reusable: reusableVal } }
  );

  const site = await BacklinkSite.findById(params.id).lean();
  if (!site) return Response.json({ error: "Not found." }, { status: 404 });

  return Response.json({
    id:          site._id.toString(),
    url:         site.url,
    da:          site.da ?? null,
    spamScore:   site.spamScore ?? null,
    niche:       site.niche ?? "",
    notes:       site.notes ?? "",
    reusable:    reusableVal,
    addedBy:     site.addedBy,
    addedByName: site.addedByName,
    createdAt:   site.createdAt.toISOString(),
  });
}

// DELETE /api/backlink-sites/[id] — own site for sub-lead, any for super-admin
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const role = session.user.role;
  if (role !== "super-admin" && role !== "sub-lead") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  await connectDB();
  const site = await BacklinkSite.findById(params.id);
  if (!site) return Response.json({ error: "Not found." }, { status: 404 });

  if (role === "sub-lead" && site.addedBy !== session.user.id) {
    return Response.json({ error: "You can only delete sites you added." }, { status: 403 });
  }

  await site.deleteOne();
  return Response.json({ success: true });
}
