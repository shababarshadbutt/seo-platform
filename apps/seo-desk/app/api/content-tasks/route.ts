import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, ContentTask, Group } from "@/lib/mongodb";
import type { ContentTaskType } from "@/lib/mongodb";

export const dynamic = "force-dynamic";

// GET /api/content-tasks?taskType=...
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const role = session.user.role;
  const myId = session.user.id;
  const { searchParams } = new URL(req.url);
  const taskType = searchParams.get("taskType");

  await connectDB();

  const filter: Record<string, unknown> = {};
  if (taskType) filter.taskType = taskType;

  if (role === "super-admin") {
    // no userId filter — sees all
  } else if (role === "sub-lead") {
    const group = await Group.findOne({ leadUserId: myId }).lean();
    const memberIds = group ? group.memberUserIds.map((id) => id.toString()) : [];
    filter.userId = { $in: [myId, ...memberIds] };
  } else {
    filter.userId = myId;
  }

  const tasks = await ContentTask.find(filter).sort({ date: -1, createdAt: -1 }).lean();

  return Response.json(
    tasks.map((t) => ({
      id: t._id.toString(),
      userId: t.userId,
      userName: t.userName,
      taskType: t.taskType,
      websiteName: t.websiteName,
      websiteUrl: t.websiteUrl,
      status: t.status,
      date: t.date.toISOString(),
      docsLink: t.docsLink ?? "",
      pageUrls: t.pageUrls ?? [],
      sheetLink: t.sheetLink ?? "",
      blogTopics: t.blogTopics ?? [],
      updatedPageLinks: t.updatedPageLinks ?? [],
      publishedBlogLinks: t.publishedBlogLinks ?? [],
      createdAt: t.createdAt.toISOString(),
    }))
  );
}

// POST /api/content-tasks
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { taskType, websiteName, websiteUrl, status, date, docsLink, pageUrls, sheetLink, blogTopics, updatedPageLinks, publishedBlogLinks } = body;

  if (!taskType || !websiteName?.trim() || !websiteUrl?.trim() || !date) {
    return Response.json({ error: "Required fields missing." }, { status: 400 });
  }

  const validTypes: ContentTaskType[] = ["landing-request", "blog-request", "landing-update", "blog-publish"];
  if (!validTypes.includes(taskType)) {
    return Response.json({ error: "Invalid task type." }, { status: 400 });
  }

  await connectDB();

  const task = await ContentTask.create({
    userId: session.user.id,
    userName: session.user.name ?? "",
    taskType,
    websiteName: websiteName.trim(),
    websiteUrl: websiteUrl.trim(),
    status: status ?? "pending",
    date: new Date(date),
    docsLink: docsLink?.trim() ?? "",
    pageUrls: Array.isArray(pageUrls) ? pageUrls.filter(Boolean) : [],
    sheetLink: sheetLink?.trim() ?? "",
    blogTopics: Array.isArray(blogTopics) ? blogTopics.filter(Boolean) : [],
    updatedPageLinks: Array.isArray(updatedPageLinks) ? updatedPageLinks.filter(Boolean) : [],
    publishedBlogLinks: Array.isArray(publishedBlogLinks) ? publishedBlogLinks.filter(Boolean) : [],
  });

  return Response.json({
    id: task._id.toString(),
    userId: task.userId,
    userName: task.userName,
    taskType: task.taskType,
    websiteName: task.websiteName,
    websiteUrl: task.websiteUrl,
    status: task.status,
    date: task.date.toISOString(),
    docsLink: task.docsLink ?? "",
    pageUrls: task.pageUrls ?? [],
    sheetLink: task.sheetLink ?? "",
    blogTopics: task.blogTopics ?? [],
    updatedPageLinks: task.updatedPageLinks ?? [],
    publishedBlogLinks: task.publishedBlogLinks ?? [],
  }, { status: 201 });
}
