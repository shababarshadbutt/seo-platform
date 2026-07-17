import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, ContentTask, Group } from "@/lib/mongodb";

async function canAccess(userId: string, role: string, myId: string): Promise<boolean> {
  if (role === "super-admin") return true;
  if (userId === myId) return true;
  if (role === "sub-lead") {
    const group = await Group.findOne({ leadUserId: myId }).lean();
    if (group) {
      return group.memberUserIds.map((id) => id.toString()).includes(userId);
    }
  }
  return false;
}

// PATCH /api/content-tasks/[id]
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  await connectDB();
  const task = await ContentTask.findById(params.id);
  if (!task) return Response.json({ error: "Not found." }, { status: 404 });

  if (!(await canAccess(task.userId, session.user.role, session.user.id))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();

  const updates: Record<string, unknown> = {};
  if ("websiteName" in body)       updates.websiteName       = body.websiteName;
  if ("websiteUrl" in body)        updates.websiteUrl        = body.websiteUrl;
  if ("status" in body)            updates.status            = body.status;
  if ("date" in body)              updates.date              = new Date(body.date);
  if ("docsLink" in body)          updates.docsLink          = body.docsLink;
  if ("pageUrls" in body)          updates.pageUrls          = body.pageUrls;
  if ("sheetLink" in body)         updates.sheetLink         = body.sheetLink;
  if ("blogTopics" in body)        updates.blogTopics        = body.blogTopics;
  if ("updatedPageLinks" in body)  updates.updatedPageLinks  = body.updatedPageLinks;
  if ("publishedBlogLinks" in body) updates.publishedBlogLinks = body.publishedBlogLinks;

  await ContentTask.updateOne({ _id: params.id }, { $set: updates }, { strict: false });

  const fresh = await ContentTask.findById(params.id).lean();
  if (!fresh) return Response.json({ error: "Not found." }, { status: 404 });

  return Response.json({
    id: fresh._id.toString(),
    userId: fresh.userId,
    userName: fresh.userName,
    taskType: fresh.taskType,
    websiteName: fresh.websiteName,
    websiteUrl: fresh.websiteUrl,
    status: fresh.status,
    date: fresh.date.toISOString(),
    docsLink: fresh.docsLink ?? "",
    pageUrls: (fresh.pageUrls as string[]) ?? [],
    sheetLink: fresh.sheetLink ?? "",
    blogTopics: (fresh.blogTopics as string[]) ?? [],
    updatedPageLinks: (fresh.updatedPageLinks as string[]) ?? [],
    publishedBlogLinks: (fresh.publishedBlogLinks as string[]) ?? [],
  });
}

// DELETE /api/content-tasks/[id]
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  await connectDB();
  const task = await ContentTask.findById(params.id);
  if (!task) return Response.json({ error: "Not found." }, { status: 404 });

  if (!(await canAccess(task.userId, session.user.role, session.user.id))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  await task.deleteOne();
  return Response.json({ success: true });
}
