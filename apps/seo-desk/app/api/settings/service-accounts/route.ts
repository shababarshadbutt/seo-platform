import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, Settings } from "@/lib/mongodb";

export const dynamic = "force-dynamic";

// GET /api/settings/service-accounts — returns just the names (no JSON)
// Available to all authenticated users so the script runner can populate the dropdown.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  await connectDB();
  const settings = await Settings.findOne({ singleton: true }).lean();

  return Response.json(
    settings?.serviceAccounts.map((a) => a.name) ?? []
  );
}
