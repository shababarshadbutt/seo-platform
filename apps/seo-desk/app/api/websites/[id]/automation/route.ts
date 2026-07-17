import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, Website } from "@/lib/mongodb";

// GET /api/websites/[id]/automation — fetch automation settings (super-admin only)
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "super-admin") return Response.json({ error: "Forbidden" }, { status: 403 });

  await connectDB();
  const w = await Website.findById(params.id).lean();
  if (!w) return Response.json({ error: "Not found." }, { status: 404 });

  const raw = w as unknown as Record<string, unknown>;
  return Response.json({
    automationEnabled:     !!(raw.automationEnabled),
    automationStartDate:   (raw.automationStartDate as Date | null)?.toISOString() ?? null,
    gscServiceAccountName: (raw.gscServiceAccountName as string) ?? "",
    bingApiKey:            (raw.bingApiKey as string) ?? "",
    robotsTxtUrl:          (raw.robotsTxtUrl as string) ?? "",
    sitemaps:              (raw.sitemaps as { url: string; discoveredAt: string }[]) ?? [],
  });
}

// PATCH /api/websites/[id]/automation — save automation settings (super-admin only)
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "super-admin") return Response.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json();
  const { automationEnabled, automationStartDate, gscServiceAccountName, bingApiKey, robotsTxtUrl, clearSitemaps } = body as {
    automationEnabled:     boolean;
    automationStartDate:   string | null;
    gscServiceAccountName: string;
    bingApiKey:            string;
    robotsTxtUrl:          string;
    clearSitemaps?:        boolean;
  };

  await connectDB();

  // Use raw MongoDB to bypass Mongoose schema caching
  const mongoose = await import("mongoose");
  await Website.collection.updateOne(
    { _id: new mongoose.default.Types.ObjectId(params.id) },
    {
      $set: {
        automationEnabled:     !!automationEnabled,
        automationStartDate:   automationStartDate ? new Date(automationStartDate) : null,
        gscServiceAccountName: gscServiceAccountName?.trim() ?? "",
        bingApiKey:            bingApiKey?.trim() ?? "",
        robotsTxtUrl:          robotsTxtUrl?.trim() ?? "",
        ...(clearSitemaps ? { sitemaps: [] } : {}),
      },
    }
  );

  const updated = await Website.findById(params.id).lean();
  if (!updated) return Response.json({ error: "Not found." }, { status: 404 });

  const raw = updated as unknown as Record<string, unknown>;
  return Response.json({
    id:                    updated._id.toString(),
    name:                  updated.name,
    automationEnabled:     !!(raw.automationEnabled),
    automationStartDate:   (raw.automationStartDate as Date | null)?.toISOString() ?? null,
    gscServiceAccountName: (raw.gscServiceAccountName as string) ?? "",
    bingApiKey:            (raw.bingApiKey as string) ?? "",
    robotsTxtUrl:          (raw.robotsTxtUrl as string) ?? "",
  });
}
