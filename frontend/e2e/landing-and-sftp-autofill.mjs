import { chromium } from "playwright";

const BASE = "http://127.0.0.1:3010";
const OUT = process.env.SHOT_DIR;
const results = [];

function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

// ---- ITEM 1: the app lands on the Cleaner --------------------------------
await page.goto(BASE + "/", { waitUntil: "networkidle" });
const landedUrl = page.url();
const cleanerHeading = await page
  .locator("text=/sitemap cleaner/i")
  .first()
  .isVisible()
  .catch(() => false);

check(
  "ITEM 1: '/' lands on the Cleaner",
  landedUrl.endsWith("/cleaner"),
  `url after load = ${landedUrl}`
);
check("ITEM 1: Cleaner UI actually rendered", cleanerHeading);
await page.screenshot({ path: `${OUT}/01-landing-is-cleaner.png`, fullPage: false });

// Navbar highlight should mark Cleaner active, not Migration.
const navCleaner = page.locator('a[href="/cleaner"]').first();
const navMigration = page.locator('a[href="/migration"]').first();
check(
  "ITEM 1: navbar still offers Migration",
  await navMigration.isVisible(),
  `href=/migration present`
);
check("ITEM 1: navbar offers Cleaner", await navCleaner.isVisible());

// ---- ITEM 2: Base URL auto-populates from the SFTP domain ----------------
await page.goto(BASE + "/migration", { waitUntil: "networkidle" });

const baseUrlInput = page.locator("#base-url");
check(
  "ITEM 2: Base URL starts empty on a fresh Migration form",
  (await baseUrlInput.inputValue()) === "",
  `value=${JSON.stringify(await baseUrlInput.inputValue())}`
);

await page.getByText("From SFTP", { exact: false }).first().click();
await page.waitForSelector("#sftp-domain", { timeout: 15000 });
await page.waitForFunction(
  () => document.querySelectorAll("#sftp-domain option").length > 1,
  { timeout: 15000 }
);
const options = await page.locator("#sftp-domain option").allTextContents();
check(
  "ITEM 2: real SFTP domains listed",
  options.includes("fastenersprocurement.com"),
  options.join(", ")
);
await page.screenshot({ path: `${OUT}/02-sftp-tab-before-select.png` });

// The incident domain: bare folder name.
await page.selectOption("#sftp-domain", "fastenersprocurement.com");
await page.waitForTimeout(400);
const filled = await baseUrlInput.inputValue();
check(
  "ITEM 2: selecting the SFTP domain FILLS Base URL in the UI",
  filled === "https://fastenersprocurement.com",
  `value=${JSON.stringify(filled)}`
);
const provenance = await page
  .getByTestId("base-url-from-sftp")
  .textContent()
  .catch(() => null);
check(
  "ITEM 2: field states where the value came from",
  Boolean(provenance && provenance.includes("fastenersprocurement.com")),
  JSON.stringify(provenance)
);
await page.screenshot({ path: `${OUT}/03-base-url-autofilled.png` });

// A www folder keeps its www — the field is the site's real public address.
await page.selectOption("#sftp-domain", "www.acquireelectrical.com");
await page.waitForTimeout(400);
const filledWww = await baseUrlInput.inputValue();
check(
  "ITEM 2: a www SFTP folder yields a www Base URL",
  filledWww === "https://www.acquireelectrical.com",
  `value=${JSON.stringify(filledWww)}`
);

// Back to the incident domain, then hand-edit to the www variant: this is the
// exact divergence that caused the incident. It must NOT warn, because both
// spellings now resolve to one publish prefix.
await page.selectOption("#sftp-domain", "fastenersprocurement.com");
await page.waitForTimeout(300);
await baseUrlInput.fill("https://www.fastenersprocurement.com");
await page.waitForTimeout(400);
check(
  "ITEM 2: www-only edit is NOT flagged as divergence (same prefix)",
  !(await page.getByTestId("base-url-divergence-warning").isVisible().catch(() => false))
);

// A genuinely different site MUST be flagged.
await baseUrlInput.fill("https://other.example.com");
await page.waitForTimeout(400);
const warned = await page
  .getByTestId("base-url-divergence-warning")
  .isVisible()
  .catch(() => false);
check("ITEM 2: a different host IS flagged as divergence", warned);
await page.screenshot({ path: `${OUT}/04-divergence-warning.png` });

// ---- ITEM 3d: History storage view ---------------------------------------
await page.goto(BASE + "/sessions", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
const panelVisible = await page
  .getByTestId("storage-panel")
  .isVisible()
  .catch(() => false);
check("ITEM 3d: storage panel renders on History", panelVisible);
await page.screenshot({ path: `${OUT}/05-history-storage-panel.png`, fullPage: true });

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed`
);
process.exit(failed.length === 0 ? 0 : 1);
