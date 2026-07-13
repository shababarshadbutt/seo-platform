import { chromium } from "playwright-core";

const sessionId = "design-results";

const sessionResponse = {
  session: {
    id: sessionId,
    name: "Migration Audit - July",
    base_url: "https://www.example.com",
    sample_size: 50,
    concurrency: 5,
    user_agent: null,
    status: "COMPLETE",
    created_at: "2026-07-03T15:00:00.000Z",
    mismatched_url_count: 2
  },
  sitemap_files: [
    {
      id: "file-1",
      session_id: sessionId,
      filename: "current-sitemap.xml",
      source_role: "current",
      total_urls: 1380,
      parsed_at: "2026-07-03T15:01:00.000Z",
      is_valid: true,
      parse_error: null,
      parse_error_offset: null,
      is_index: false,
      had_preamble_stripped: false,
      is_empty: false,
      mismatched_url_count: 2
    }
  ]
};

const patterns = [
  {
    id: "p1",
    session_id: sessionId,
    source_role: "current",
    template: "/products/{param}",
    total_urls: 760,
    coverage_pct: 55,
    confidence_pct: 96,
    status: "GOOD",
    has_suspicious_segment: false,
    suspicious_segment_value: null,
    redirect_pct: 4,
    missing_in_current: false
  },
  {
    id: "p2",
    session_id: sessionId,
    source_role: "current",
    template: "/blog/{param}",
    total_urls: 320,
    coverage_pct: 23,
    confidence_pct: 72,
    status: "WARNING",
    has_suspicious_segment: false,
    suspicious_segment_value: null,
    redirect_pct: 18,
    missing_in_current: false
  },
  {
    id: "p3",
    session_id: sessionId,
    source_role: "current",
    template: "/old-category/{param}",
    total_urls: 180,
    coverage_pct: 13,
    confidence_pct: 38,
    status: "BAD",
    has_suspicious_segment: true,
    suspicious_segment_value: "old-category",
    redirect_pct: 74,
    missing_in_current: false
  },
  {
    id: "p4",
    session_id: sessionId,
    source_role: "current",
    template: "/search/{param}",
    total_urls: 120,
    coverage_pct: 9,
    confidence_pct: 64,
    status: "WARNING",
    has_suspicious_segment: false,
    suspicious_segment_value: null,
    redirect_pct: 8,
    missing_in_current: false
  },
  {
    id: "p5",
    session_id: sessionId,
    source_role: "legacy",
    template: "/legacy-only/{param}",
    total_urls: 90,
    coverage_pct: 0,
    confidence_pct: 0,
    status: "BAD",
    has_suspicious_segment: false,
    suspicious_segment_value: null,
    redirect_pct: 0,
    missing_in_current: true
  }
];

const sample = (patternId, index, overrides = {}) => ({
  id: `${patternId}-s${index}`,
  pattern_id: patternId,
  url: `https://www.example.com/${patternId}/${index}`,
  http_status: 200,
  response_ms: 142 + index,
  is_hit: true,
  checked_at: "2026-07-03T15:03:00.000Z",
  final_url: null,
  redirect_count: 0,
  http_status_category: "success",
  is_soft_404: false,
  ...overrides
});

const samplesByPattern = {
  p1: [sample("p1", 1), sample("p1", 2), sample("p1", 3)],
  p2: [
    sample("p2", 1),
    sample("p2", 2, {
      http_status: 302,
      final_url: "https://www.example.com/articles/2",
      redirect_count: 1,
      http_status_category: "redirect"
    }),
    sample("p2", 3)
  ],
  p3: [
    sample("p3", 1, {
      url: "https://www.example.com/old-category/widget-a",
      http_status: 301,
      final_url: "https://www.example.com/category/widget-a",
      redirect_count: 1,
      http_status_category: "redirect"
    }),
    sample("p3", 2, {
      url: "https://www.example.com/old-category/widget-b",
      http_status: 404,
      response_ms: 388,
      is_hit: false,
      http_status_category: "failure"
    }),
    sample("p3", 3, {
      url: "https://www.example.com/old-category/widget-c",
      http_status: 301,
      final_url: "https://www.example.com/category/widget-c",
      redirect_count: 1,
      http_status_category: "redirect"
    })
  ],
  p4: [
    sample("p4", 1, {
      url: "https://www.example.com/search/empty-results",
      http_status: 200,
      is_hit: false,
      http_status_category: "success",
      is_soft_404: true
    }),
    sample("p4", 2)
  ],
  p5: [sample("p5", 1, { is_hit: false, http_status: 404, http_status_category: "failure" })]
};

const mismatchedUrls = {
  mismatched_urls: [
    {
      id: "m1",
      sitemap_file_id: "file-1",
      session_id: sessionId,
      filename: "current-sitemap.xml",
      url: "https://staging.example.com/products/widget-a",
      detected_host: "staging.example.com",
      expected_host: "www.example.com",
      created_at: "2026-07-03T15:04:00.000Z"
    },
    {
      id: "m2",
      sitemap_file_id: "file-1",
      session_id: sessionId,
      filename: "current-sitemap.xml",
      url: "https://old.example.com/blog/launch",
      detected_host: "old.example.com",
      expected_host: "www.example.com",
      created_at: "2026-07-03T15:04:00.000Z"
    }
  ]
};

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
const page = await browser.newPage({ viewport: { width: 1440, height: 1500 } });

await page.route(`**/api/sessions/${sessionId}**`, async (route) => {
  const pathname = new URL(route.request().url()).pathname;

  if (pathname.endsWith("/mismatched-urls")) {
    await route.fulfill(json(mismatchedUrls));
    return;
  }

  if (pathname.endsWith("/patterns")) {
    await route.fulfill(json({ patterns }));
    return;
  }

  if (pathname.includes("/patterns/") && pathname.endsWith("/samples")) {
    const patternId = pathname.split("/").at(-2);
    await route.fulfill(json({ sampled_urls: samplesByPattern[patternId] ?? [] }));
    return;
  }

  await route.fulfill(json(sessionResponse));
});

await page.goto(`http://frontend:3000/sessions/${sessionId}/results`, {
  waitUntil: "networkidle",
  timeout: 120000
});
await page.waitForSelector('[data-testid="summary-cards"]', { timeout: 60000 });
await page.waitForTimeout(500);
await page.screenshot({
  path: "/tmp/design-results-screen.png",
  fullPage: true
});
await browser.close();
