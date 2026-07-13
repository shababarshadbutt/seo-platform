import { chromium } from "playwright-core";

const sessions = [
  {
    id: "h1",
    name: "Migration Audit - July",
    base_url: "https://www.example.com",
    status: "COMPLETE",
    created_at: "2026-07-03T15:00:00.000Z",
    mismatched_url_count: 2,
    total_urls: 1380,
    pattern_count: 18,
    healthy_count: 13,
    warning_count: 4,
    broken_count: 1,
    health_score: 88,
    empty_sitemap_count: 0
  },
  {
    id: "h2",
    name: "Legacy Blog Consolidation",
    base_url: "https://blog.example.com",
    status: "COMPLETED",
    created_at: "2026-06-27T11:25:00.000Z",
    mismatched_url_count: 0,
    total_urls: 840,
    pattern_count: 12,
    healthy_count: 7,
    warning_count: 4,
    broken_count: 1,
    health_score: 62,
    empty_sitemap_count: 1
  },
  {
    id: "h3",
    name: "Storefront URL Cleanup",
    base_url: "https://shop.example.com",
    status: "FAILED",
    created_at: "2026-06-18T09:10:00.000Z",
    mismatched_url_count: 5,
    total_urls: 420,
    pattern_count: 9,
    healthy_count: 2,
    warning_count: 3,
    broken_count: 4,
    health_score: 34,
    empty_sitemap_count: 0
  }
];

const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium-browser",
  args: ["--no-sandbox", "--disable-dev-shm-usage"]
});
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });

await page.route("**/api/sessions", async (route) => {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ sessions })
  });
});

await page.goto("http://frontend:3000/sessions", {
  waitUntil: "networkidle",
  timeout: 120000
});
await page.waitForSelector('[data-session-row="h1"]', { timeout: 60000 });
await page.hover('[data-session-row="h1"]');
await page.screenshot({
  path: "/tmp/design-history-screen.png",
  fullPage: true
});
await browser.close();
