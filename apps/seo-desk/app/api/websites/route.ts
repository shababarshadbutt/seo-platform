import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, Website, Group } from "@/lib/mongodb";

export const dynamic = "force-dynamic";

// GET /api/websites — role-filtered list
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const role = session.user.role;
  const myId = session.user.id;

  await connectDB();

  let websites;

  if (role === "super-admin") {
    websites = await Website.find().sort({ name: 1 }).lean();
  } else if (role === "sub-lead") {
    const group = await Group.findOne({ leadUserId: myId }).lean();
    const memberIds = group ? group.memberUserIds.map((id) => id.toString()) : [];
    const allIds = [myId, ...memberIds];
    websites = await Website.find({ "assignedTo.userId": { $in: allIds } }).sort({ name: 1 }).lean();
  } else {
    websites = await Website.find({ "assignedTo.userId": myId }).sort({ name: 1 }).lean();
  }

  return Response.json(
    websites.map((w) => ({
      id:         w._id.toString(),
      name:       w.name,
      url:        w.url ?? "",
      assignedTo: w.assignedTo,
      createdAt:  w.createdAt.toISOString(),
    }))
  );
}

// POST /api/websites — super-admin only
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "super-admin") return Response.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json();
  const { name, url } = body;

  if (!name?.trim()) return Response.json({ error: "Website name is required." }, { status: 400 });

  await connectDB();

  const created = await Website.create({ name: name.trim(), url: url?.trim() ?? "" });

  return Response.json({
    id:         created._id.toString(),
    name:       created.name,
    url:        created.url,
    assignedTo: [],
    createdAt:  created.createdAt.toISOString(),
  }, { status: 201 });
}
