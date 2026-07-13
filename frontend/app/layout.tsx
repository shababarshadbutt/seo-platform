import type { Metadata } from "next";
import { AppNavbar } from "@/components/app-navbar";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sitemap Migration Health Checker",
  description: "Local sitemap migration analysis tool"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <AppNavbar />
        {children}
      </body>
    </html>
  );
}
