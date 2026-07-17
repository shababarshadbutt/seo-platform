import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, Settings } from "@/lib/mongodb";

// POST /api/settings/credentials — add a service account
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user.role !== "super-admin") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const { name, credentialsJson } = await req.json();

  if (!name?.trim()) {
    return Response.json({ error: "Account name is required." }, { status: 400 });
  }
  if (!credentialsJson?.trim()) {
    return Response.json({ error: "Credentials JSON is required." }, { status: 400 });
  }

  try {
    const parsed = JSON.parse(credentialsJson);
    if (parsed.type !== "service_account") {
      return Response.json(
        { error: "Invalid credentials: must be a Google service account JSON file." },
        { status: 400 }
      );
    }
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }

  await connectDB();

  const settings = await Settings.findOne({ singleton: true }).lean();
  const existing = settings?.serviceAccounts ?? [];

  // Don't allow duplicate names
  if (existing.some((a) => a.name.toLowerCase() === name.trim().toLowerCase())) {
    return Response.json(
      { error: `An account named "${name.trim()}" already exists.` },
      { status: 409 }
    );
  }

  const updated = await Settings.findOneAndUpdate(
    { singleton: true },
    { $push: { serviceAccounts: { name: name.trim(), json: credentialsJson.trim() } } },
    { upsert: true, new: true }
  ).lean();

  return Response.json({
    serviceAccounts: updated?.serviceAccounts.map((a) => ({ name: a.name })) ?? [],
  });
}

// DELETE /api/settings/credentials — remove a service account by name
export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user.role !== "super-admin") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const { name } = await req.json();
  if (!name?.trim()) {
    return Response.json({ error: "Account name is required." }, { status: 400 });
  }

  await connectDB();

  const updated = await Settings.findOneAndUpdate(
    { singleton: true },
    { $pull: { serviceAccounts: { name: name.trim() } } },
    { new: true }
  ).lean();

  return Response.json({
    serviceAccounts: updated?.serviceAccounts.map((a) => ({ name: a.name })) ?? [],
  });
}
