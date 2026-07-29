import { redirect } from "next/navigation";

// The app lands on the Sitemap Cleaner.
//
// Cleaning is the first step of the real workflow — sitemaps come off SFTP, get
// cleaned, and only then go through migration analysis — so the Cleaner is what
// the SEO team wants in front of them when they open the tool. Migration keeps
// its own route at /migration and is still one click away in the navbar.
//
// A server-side redirect rather than a client-side router.replace(): this runs
// before anything is sent to the browser, so there is no flash of the Migration
// page and no history entry to trap the Back button on.
//
// Kept as a redirect rather than moving the Cleaner's code here so /cleaner stays
// a real, linkable route — the navbar, the Cleaner→Migration handoff, and any
// bookmark the team already has all keep working.
export default function HomePage() {
  redirect("/cleaner");
}
