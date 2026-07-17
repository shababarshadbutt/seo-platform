"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import { useState, useEffect } from "react";
import {
  LayoutDashboard,
  Play,
  ScrollText,
  Users,
  Settings,
  LogOut,
  Crown,
  Link2,
  Database,
  FileText,
  ClipboardList,
  ClipboardCheck,
  ChevronDown,
  Globe,
  BarChart2,
  ListChecks,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Nav config ───────────────────────────────────────────────────────────────

type NavItem =
  | { kind: "link"; href: string; label: string; icon: React.ElementType; minRole: string }
  | {
      kind: "group";
      label: string;
      icon: React.ElementType;
      minRole: string;
      basePath: string;
      children: { href: string; label: string }[];
    };

const navItems: NavItem[] = [
  { kind: "link", href: "/", label: "Overview", icon: LayoutDashboard, minRole: "admin" },
  { kind: "link", href: "/scripts", label: "Scripts", icon: Play, minRole: "admin" },
  { kind: "link", href: "/backlinks", label: "Backlinks", icon: Link2, minRole: "admin" },
  { kind: "link", href: "/backlink-sites", label: "Backlink Sites", icon: Database, minRole: "sub-lead" },
  { kind: "link", href: "/websites",       label: "Websites",        icon: Globe,      minRole: "admin" },
  { kind: "link", href: "/weekly-reports", label: "Weekly Reports",  icon: BarChart2,  minRole: "admin" },
  {
    kind: "group",
    label: "Content Request",
    icon: FileText,
    minRole: "admin",
    basePath: "/content",
    children: [
      { href: "/content?type=landing-request", label: "Landing Pages Request" },
      { href: "/content?type=blog-request", label: "Blogs Request" },
    ],
  },
  {
    kind: "group",
    label: "Content Update",
    icon: FileText,
    minRole: "admin",
    basePath: "/content",
    children: [
      { href: "/content?type=landing-update", label: "Landing Pages Update" },
      { href: "/content?type=blog-publish", label: "Blogs Publish" },
    ],
  },
  { kind: "link", href: "/daily-reports", label: "Daily Reports", icon: ClipboardList, minRole: "admin" },
  { kind: "link", href: "/audit", label: "Website Audit", icon: ClipboardCheck, minRole: "admin" },
  { kind: "link", href: "/logs", label: "Logs", icon: ScrollText, minRole: "admin" },
  { kind: "link", href: "/indexing-queue", label: "Indexing Queue", icon: ListChecks, minRole: "super-admin" },
  { kind: "link", href: "/users", label: "Users", icon: Users, minRole: "super-admin" },
  { kind: "link", href: "/settings", label: "Settings", icon: Settings, minRole: "super-admin" },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function roleRank(role?: string): number {
  if (role === "super-admin") return 3;
  if (role === "sub-lead") return 2;
  if (role === "admin") return 1;
  return 0;
}

function minRoleRank(minRole: string): number {
  if (minRole === "super-admin") return 3;
  if (minRole === "sub-lead") return 2;
  if (minRole === "admin") return 1;
  return 0;
}

function roleBadgeLabel(role?: string) {
  if (role === "super-admin") return "Admin";
  if (role === "sub-lead") return "Supervisor";
  return "User";
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

export function Sidebar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const role = session?.user?.role;
  const myRank = roleRank(role);

  const activeType = searchParams.get("type") ?? "";

  // Track which groups are open — auto-open if a child is active
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    navItems.forEach((item) => {
      if (item.kind === "group") {
        const anyActive = item.children.some((c) => {
          const [childPath, childQuery] = c.href.split("?");
          const childType = new URLSearchParams(childQuery ?? "").get("type") ?? "";
          return pathname === childPath && activeType === childType;
        });
        if (anyActive) init[item.label] = true;
      }
    });
    return init;
  });

  // Auto-open active group, auto-close all others on navigation
  useEffect(() => {
    setOpenGroups((prev) => {
      const next = { ...prev };
      navItems.forEach((item) => {
        if (item.kind === "group") {
          const anyActive = item.children.some((c) => {
            const [childPath, childQuery] = c.href.split("?");
            const childType = new URLSearchParams(childQuery ?? "").get("type") ?? "";
            return pathname === childPath && activeType === childType;
          });
          next[item.label] = anyActive;
        }
      });
      return next;
    });
  }, [pathname, activeType]);

  function toggleGroup(label: string) {
    setOpenGroups((prev) => ({ ...prev, [label]: !prev[label] }));
  }

  const visible = navItems.filter((item) => myRank >= minRoleRank(item.minRole));

  return (
    <aside className="flex h-screen w-64 flex-col bg-gray-900 text-gray-100">
      {/* Brand */}
      <div className="flex items-center px-6 py-5 border-b border-gray-700">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/dashboard-logo.png" alt="ASAP" className="h-14 w-auto object-contain" />
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-0.5 px-3 py-4 overflow-y-auto">
        {visible.map((item) => {
          if (item.kind === "link") {
            const isActive = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-blue-600 text-white"
                    : "text-gray-400 hover:bg-gray-800 hover:text-gray-100"
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {item.label}
              </Link>
            );
          }

          // Group item
          const Icon = item.icon;
          const isOpen = !!openGroups[item.label];
          const isAnyChildActive = item.children.some((c) => {
            const [childPath, childQuery] = c.href.split("?");
            const childType = new URLSearchParams(childQuery ?? "").get("type") ?? "";
            return pathname === childPath && activeType === childType;
          });

          return (
            <div key={item.label}>
              <button
                onClick={() => toggleGroup(item.label)}
                className={cn(
                  "w-full flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isAnyChildActive
                    ? "text-blue-400 bg-gray-800"
                    : "text-gray-400 hover:bg-gray-800 hover:text-gray-100"
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="flex-1 text-left">{item.label}</span>
                <ChevronDown className={cn(
                  "h-3.5 w-3.5 transition-transform duration-200",
                  isOpen && "rotate-180"
                )} />
              </button>

              <div className={cn(
                "grid transition-all duration-200 ease-in-out",
                isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
              )}>
                <div className="overflow-hidden">
                  <div className="mt-0.5 ml-4 pl-3 border-l border-gray-700 space-y-0.5 pb-0.5">
                    {item.children.map((child) => {
                      const [childPath, childQuery] = child.href.split("?");
                      const childType = new URLSearchParams(childQuery ?? "").get("type") ?? "";
                      const isChildActive = pathname === childPath && activeType === childType;
                      return (
                        <Link
                          key={child.href}
                          href={child.href}
                          className={cn(
                            "block rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                            isChildActive
                              ? "bg-blue-600 text-white"
                              : "text-gray-400 hover:bg-gray-800 hover:text-gray-100"
                          )}
                        >
                          {child.label}
                        </Link>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </nav>

      {/* User + sign out */}
      <div className="border-t border-gray-700 px-4 py-4 space-y-3">
        <div className="flex items-center gap-3 px-1">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-600 text-xs font-bold uppercase">
            {session?.user?.name?.[0] ?? "?"}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-gray-100">
              {session?.user?.name}
            </p>
            <div className="flex items-center gap-1">
              {role === "super-admin" && (
                <Crown className="h-3 w-3 text-yellow-400" />
              )}
              <p className="truncate text-xs text-gray-400">
                {roleBadgeLabel(role)}
              </p>
            </div>
          </div>
        </div>
        <button
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-gray-400 hover:bg-gray-800 hover:text-gray-100 transition-colors"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
      </div>
    </aside>
  );
}
