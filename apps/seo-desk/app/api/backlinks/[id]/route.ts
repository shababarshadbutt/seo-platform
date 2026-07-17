import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, Backlink, Group } from "@/lib/mongodb";

function toRow(b: Record<string, unknown> & { _id: { toString(): string }; createdAt: Date }) {
  return {
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
    rejectedByName:  b.rejectedByName ?? "",
    createdAt:       b.createdAt.toISOString(),
  };
}

// PATCH /api/backlinks/[id]
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  await connectDB();
  const existing = await Backlink.findById(params.id);
  if (!existing) return Response.json({ error: "Not found." }, { status: 404 });

  const role         = session.user.role;
  const isOwner      = existing.userId === session.user.id;
  const isSuperAdmin = role === "super-admin";
  const isSupervisor = role === "sub-lead";

  const body = await req.json();

  // ── Approve / reject (supervisor + super-admin only) ──
  if (body.action === "approve" || body.action === "reject") {
    if (!isSuperAdmin && !isSupervisor) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    // Supervisor can only act on their team's backlinks
    if (isSupervisor) {
      const group = await Group.findOne({ leadUserId: session.user.id }).lean();
      const allowed = group
        ? [session.user.id, ...group.memberUserIds.map((id) => id.toString())]
        : [session.user.id];
      if (!allowed.includes(existing.userId)) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    existing.approvalStatus  = body.action === "approve" ? "approved" : "rejected";
    existing.rejectionReason = body.action === "reject" ? (body.rejectionReason ?? "") : "";
    existing.rejectedByName  = body.action === "reject" ? (session.user.name ?? "") : "";
    await existing.save();
    return Response.json(toRow(existing.toObject() as unknown as Record<string, unknown> & { _id: { toString(): string }; createdAt: Date }));
  }

  // ── Regular edit (owner or super-admin only) ──
  if (!isOwner && !isSuperAdmin) {
    return Response.json({ error: "You can only edit your own backlinks." }, { status: 403 });
  }

  const allowed = ["websiteName", "targetUrl", "backlinkUrl", "anchorText", "type", "da", "status", "notes"];
  const update: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) update[key] = body[key];
  }
  if (body.date) update.createdAt = new Date(body.date);

  const updated = await Backlink.findByIdAndUpdate(params.id, update, { new: true }).lean();
  if (!updated) return Response.json({ error: "Not found." }, { status: 404 });

  return Response.json(toRow(updated as unknown as Record<string, unknown> & { _id: { toString(): string }; createdAt: Date }));
}

// DELETE /api/backlinks/[id]
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  await connectDB();
  const existing = await Backlink.findById(params.id);
  if (!existing) return Response.json({ error: "Not found." }, { status: 404 });

  const isOwner      = existing.userId === session.user.id;
  const isSuperAdmin = session.user.role === "super-admin";

  if (!isOwner && !isSuperAdmin) {
    return Response.json({ error: "You can only delete your own backlinks." }, { status: 403 });
  }

  await Backlink.findByIdAndDelete(params.id);
  return Response.json({ success: true });
}
