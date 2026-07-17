import { Suspense } from "react";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, Website, User, Group, Settings } from "@/lib/mongodb";
import { WebsitesClient, type WebsiteRow, type MemberOption } from "./websites-client";

export default async function WebsitesPage() {
  const session = await getServerSession(authOptions);
  const role  = session!.user.role;
  const myId  = session!.user.id;

  await connectDB();

  // Build member list — for assignment dialog (super-admin) and filter (super-admin + sub-lead)
  const members: MemberOption[] = [];

  if (role === "super-admin") {
    const users = await User.find({ isActive: true, role: { $ne: "super-admin" } })
      .sort({ name: 1 })
      .lean();
    users.forEach((u) => members.push({ id: u._id.toString(), name: u.name }));
  } else if (role === "sub-lead") {
    const group = await Group.findOne({ leadUserId: myId }).lean();
    const memberIds = group ? group.memberUserIds.map((id) => id.toString()) : [];
    const allIds = [myId, ...memberIds];
    const users = await User.find({ _id: { $in: allIds }, isActive: true }).sort({ name: 1 }).lean();
    users.forEach((u) => members.push({ id: u._id.toString(), name: u.name }));
  }

  // Fetch websites based on role
  let rawWebsites;
  if (role === "super-admin") {
    rawWebsites = await Website.find().sort({ name: 1 }).lean();
  } else if (role === "sub-lead") {
    const group = await Group.findOne({ leadUserId: myId }).lean();
    const memberIds = group ? group.memberUserIds.map((id) => id.toString()) : [];
    const allIds = [myId, ...memberIds];
    rawWebsites = await Website.find({ "assignedTo.userId": { $in: allIds } }).sort({ name: 1 }).lean();
  } else {
    rawWebsites = await Website.find({ "assignedTo.userId": myId }).sort({ name: 1 }).lean();
  }

  const websites: WebsiteRow[] = rawWebsites.map((w) => {
    const raw = w as unknown as Record<string, unknown>;
    return {
      id:         w._id.toString(),
      name:       w.name,
      url:        w.url ?? "",
      assignedTo: w.assignedTo.map((a) => ({ userId: a.userId, userName: a.userName })),
      createdAt:  w.createdAt.toISOString(),
      // automation fields — only populated for super-admin
      automationEnabled:     role === "super-admin" ? !!(raw.automationEnabled)                                                        : false,
      automationStartDate:   role === "super-admin" ? ((raw.automationStartDate as Date | null)?.toISOString() ?? null)              : null,
      gscServiceAccountName: role === "super-admin" ? ((raw.gscServiceAccountName as string) ?? "")                                 : "",
      bingApiKey:            role === "super-admin" ? ((raw.bingApiKey as string) ?? "")                                            : "",
      robotsTxtUrl:          role === "super-admin" ? ((raw.robotsTxtUrl as string) ?? "")                                          : "",
      sitemapCount:          role === "super-admin" ? ((raw.sitemaps as unknown[]) ?? []).length                                     : 0,
    };
  });

  // Service account names for the automation dialog (super-admin only)
  let serviceAccountNames: string[] = [];
  if (role === "super-admin") {
    const settings = await Settings.findOne({ singleton: true }).lean();
    serviceAccountNames = (settings?.serviceAccounts ?? []).map((a) => a.name);
  }

  return (
    <Suspense>
      <WebsitesClient
        websites={websites}
        members={members}
        viewerRole={role}
        currentUserId={myId}
        serviceAccountNames={serviceAccountNames}
      />
    </Suspense>
  );
}
