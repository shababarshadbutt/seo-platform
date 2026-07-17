import { Suspense } from "react";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB, BacklinkSite } from "@/lib/mongodb";
import { BacklinkSitesClient, type BacklinkSiteRow } from "./backlink-sites-client";

export default async function BacklinkSitesPage() {
  const session = await getServerSession(authOptions);
  const role = session!.user.role;

  if (role !== "super-admin" && role !== "sub-lead") {
    return (
      <div className="p-8 text-sm text-muted-foreground">
        You don&apos;t have access to this page.
      </div>
    );
  }

  await connectDB();

  const raw = await BacklinkSite.find({}).sort({ createdAt: -1 }).lean();

  const sites: BacklinkSiteRow[] = raw.map((s) => ({
    id:          s._id.toString(),
    url:         s.url,
    da:          s.da ?? null,
    spamScore:   s.spamScore ?? null,
    niche:       s.niche ?? "",
    notes:       s.notes ?? "",
    reusable:    !!(s as unknown as Record<string, unknown>).reusable,
    addedBy:     s.addedBy,
    addedByName: s.addedByName,
    createdAt:   s.createdAt.toISOString(),
  }));

  return (
    <Suspense>
      <BacklinkSitesClient
        sites={sites}
        viewerRole={role}
        currentUserId={session!.user.id}
      />
    </Suspense>
  );
}
