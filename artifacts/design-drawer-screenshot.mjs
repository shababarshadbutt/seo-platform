import { chromium } from "playwright-core";

const sessionId = "design-drawer";

const sessionResponse = {
  session: {
    id: sessionId,
    name: "Drawer Status Audit",
    base_url: "https://www.example.com",
    sample_size: 50,
    concurrency: 5,
    user_agent: null,
    status: "COMPLETE",
    created_at: "2026-07-03T15:00:00.000Z",
    mismatched_url_count: 0
  },
  sitemap_files: [
    {
      id: "file-1",
      session_id: sessionId,
      filename: "current-sitemap.xml",
      source_role: "current",
      total_urls: 4,
      parsed_at: "2026-07-03T15:01:00.000Z",
      is_valid: true,
      parse_error: null,
      parse_error_offset: null,
      is_index: false,
      had_preamble_stripped: false,
      is_empty: false,
      mismatched_url_count: 0
    }
  ]
};

const patterns = [
  {
    id: "p1",
    session_id: sessionId,
    source_role: "current",
    template: "/products/{param}",
    total_urls: 4,
    coverage_pct: 100,
    confidence_pct: 50,
    status: "WARNING",
    has_suspicious_segment: false,
    suspicious_segment_value: null,
    redirect_pct: 25,
    missing_in_current: false
  }
];

const sampled_urls = [
  {
    id: "s1",
    pattern_id: "p1",
    url: "https://www.example.com/products/alpha-running-shoe-long-canonical-url",
    http_status: 200,
    response_ms: 118,
    is_hit: true,
    checked_at: "2026-07-03T15:03:00.000Z",
    final_url: null,
    redirect_count: 0,
    http_status_category: "success",
    is_soft_404: false
  },
  {
    id: "s2",
    pattern_id: "p1",
    url: "https://www.example.com/products/legacy-widget",
    http_status: 301,
    response_ms: 220,
    is_hit: true,
    checked_at: "2026-07-03T15:03:00.000Z",
    final_url: "https://www.example.com/catalog/legacy-widget",
    redirect_count: 1,
    http_status_category: "redirect",
    is_soft_404: false
  },
  {
    id: "s3",
    pattern_id: "p1",
    url: "https://www.example.com/products/empty-search-result",
    http_status: 200,
    response_ms: 186,
    is_hit: false,
    checked_at: "2026-07-03T15:03:00.000Z",
    final_url: null,
    redirect_count: 0,
    http_status_category: "success",
    is_soft_404: true
  },
  {
    id: "s4",
    pattern_id: "p1",
    url: "https://www.example.com/products/missing-widget",
    http_status: 404,
    response_ms: 344,
    is_hit: false,
    checked_at: "2026-07-03T15:03:00.000Z",
    final_url: null,
    redirect_count: 0,
    http_status_category: "failure",
    is_soft_404: false
  }
];

function json(body) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body)
  };
}

const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium-browser",
  args: ["--no-sandbox", "--disable-dev-shm-usage"]
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

await page.route(`**/api/sessions/${sessionId}**`, async (route) => {
  const pathname = new URL(route.request().url()).pathname;

  if (pathname.endsWith("/mismatched-urls")) {
    await route.fulfill(json({ mismatched_urls: [] }));
    return;
  }

  if (pathname.endsWith("/patterns")) {
    await route.fulfill(json({ patterns }));
    return;
  }

  if (pathname.includes("/patterns/") && pathname.endsWith("/samples")) {
    await route.fulfill(json({ sampled_urls }));
    return;
  }

  await route.fulfill(json(sessionResponse));
});

await page.goto(`http://frontend:3000/sessions/${sessionId}/results`, {
  waitUntil: "networkidle",
  timeout: 120000
});
await page.waitForSelector('[data-pattern-row="p1"]', { timeout: 60000 });
await page.click('[data-pattern-row="p1"]');
await page.waitForSelector('[data-testid="sample-url-list"]', { timeout: 60000 });
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(250);
await page.screenshot({
  path: "/tmp/design-drawer-screen.png",
  fullPage: true
});
await browser.close();
