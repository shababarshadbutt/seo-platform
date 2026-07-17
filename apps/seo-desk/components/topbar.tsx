"use client";

import { usePathname } from "next/navigation";

const pageTitles: Record<string, string> = {
  "/": "Overview",
  "/scripts": "Scripts",
  "/logs": "Execution Logs",
  "/users": "User Management",
  "/settings": "Settings",
};

function getTitle(pathname: string): string {
  // Exact match first
  if (pageTitles[pathname]) return pageTitles[pathname];
  // Prefix match (e.g. /scripts/url-indexer → "Scripts")
  const match = Object.keys(pageTitles).find(
    (key) => key !== "/" && pathname.startsWith(key)
  );
  return match ? pageTitles[match] : "ASAP Dashboard";
}

export function Topbar() {
  const pathname = usePathname();

  return (
    <header className="flex h-14 items-center border-b border-border bg-background px-6">
      <h1 className="text-base font-semibold text-foreground">
        {getTitle(pathname)}
      </h1>
    </header>
  );
}
