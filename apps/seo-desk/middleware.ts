import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";

export default withAuth(
  function middleware(req) {
    const { pathname } = req.nextUrl;
    const role = req.nextauth.token?.role as string | undefined;

    // Settings and Users: super-admin only
    const superAdminRoutes = ["/settings", "/users"];
    if (superAdminRoutes.some((r) => pathname.startsWith(r)) && role !== "super-admin") {
      return NextResponse.redirect(new URL("/", req.url));
    }

    // Logs: super-admin and sub-lead can see all/group activity; admin sees own
    if (pathname.startsWith("/logs") && !role) {
      return NextResponse.redirect(new URL("/", req.url));
    }

    return NextResponse.next();
  },
  {
    callbacks: {
      authorized: ({ token }) => !!token,
    },
  }
);

// Protect all routes except login, NextAuth API, and static assets
export const config = {
  matcher: [
    "/((?!login|api/auth|api/cron|_next/static|_next/image|favicon\\.ico|dashboard-logo\\.png|dashboard-favicon\\.png|login-logo\\.png).*)",
  ],
};
