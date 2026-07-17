import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, Website } from "@/lib/mongodb";

function superAdminOnly(role?: string) {
  return role === "super-admin";
}

// PATCH /api/websites/[id] — update name/url or assignedTo
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!superAdminOnly(session.user.role)) return Response.json({ error: "Forbidden" }, { status: 403 });

  await connectDB();

  const website = await Website.findById(params.id);
  if (!website) return Response.json({ error: "Not found." }, { status: 404 });

  const body = await req.json();

  if (body.name !== undefined) website.name = body.name.trim();
  if (body.url  !== undefined) website.url  = body.url.trim();

  // Full replacement of assignedTo array
  if (body.assignedTo !== undefined) {
    website.assignedTo = body.assignedTo;
  }

  await website.save();

  return Response.json({
    id:         website._id.toString(),
    name:       website.name,
    url:        website.url,
    assignedTo: website.assignedTo,
    createdAt:  website.createdAt.toISOString(),
  });
}

// DELETE /api/websites/[id] — super-admin only
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!superAdminOnly(session.user.role)) return Response.json({ error: "Forbidden" }, { status: 403 });

  await connectDB();

  const website = await Website.findByIdAndDelete(params.id);
  if (!website) return Response.json({ error: "Not found." }, { status: 404 });

  return Response.json({ success: true });
}
