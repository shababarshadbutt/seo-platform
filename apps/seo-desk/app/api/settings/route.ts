import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, Settings } from "@/lib/mongodb";

export const dynamic = "force-dynamic";

// GET /api/settings
export async function GET() {
  const session = await getServerSession(authOptions);
  if (session?.user.role !== "super-admin") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  await connectDB();
  const settings = await Settings.findOne({ singleton: true }).lean();

  return Response.json({
    serviceAccounts: settings?.serviceAccounts.map((a) => ({ name: a.name })) ?? [],
    gscProperties: settings?.gscProperties ?? [],
    ga4Properties: settings?.ga4Properties ?? [],
  });
}

// PATCH /api/settings — update GSC / GA4 properties
export async function PATCH(req: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user.role !== "super-admin") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const update: Record<string, unknown> = {};

  if (Array.isArray(body.gscProperties)) update.gscProperties = body.gscProperties;
  if (Array.isArray(body.ga4Properties)) update.ga4Properties = body.ga4Properties;

  if (Object.keys(update).length === 0) {
    return Response.json({ error: "Nothing to update." }, { status: 400 });
  }

  await connectDB();

  const settings = await Settings.findOneAndUpdate(
    { singleton: true },
    { $set: update },
    { upsert: true, new: true }
  ).lean();

  return Response.json({
    serviceAccounts: settings?.serviceAccounts.map((a) => ({ name: a.name })) ?? [],
    gscProperties: settings?.gscProperties ?? [],
    ga4Properties: settings?.ga4Properties ?? [],
  });
}
