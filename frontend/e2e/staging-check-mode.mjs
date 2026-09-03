import { chromium } from "playwright";

// The 1.90 / 2.0 URL-check toggle, in the rendered UI.
//
// Everything here is invisible to `npm test`, which runs lib/**/*.test.ts only:
// the toggle renders nothing until its fetch resolves, the derived placeholder is
// computed during typing, and the confirm dialog is the one thing standing between
// a stray click and every user's checks moving to another server.
//
// See e2e/README.md for the stack this expects. Exits non-zero on the first failed
// assertion.
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3010";
const OUT = process.env.SHOT_DIR;
const results = [];

function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function shoot(page, name) {
  if (OUT) {
    await page.screenshot({ path: `${OUT}/${name}.png` });
  }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// Always start from a known mode, so a previous run cannot decide this one.
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.evaluate(() =>
  fetch("/api/backend/api/settings/url-check-mode", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "1.90" })
  })
);

await page.goto(`${BASE}/migration`, { waitUntil: "networkidle" });
await page.waitForSelector("text=2.0 · staging", { timeout: 20000 });

const prodBtn = page.locator("button", { hasText: "1.90 · prod" });
const stagingBtn = page.locator("button", { hasText: "2.0 · staging" });

check(
  "the toggle renders in the navbar with both modes labelled",
  (await prodBtn.isVisible()) && (await stagingBtn.isVisible())
);

// Never a bare "1.90": next to a version pill reading v1.90 that would be
// unreadable, which is why the labels carry the environment.
const stagingLabel = (await stagingBtn.innerText()).trim();
check(
  "the labels name the environment, not just a number",
  stagingLabel.includes("staging"),
  stagingLabel
);

// The derived staging origin is shown BEFORE the session exists, which is the
// mitigation for the derivation being wrong on unusual hosts.
await page.locator("#base-url").fill("https://www.asapsemi.com");
const placeholder = await page
  .locator("#staging-base-url")
  .getAttribute("placeholder");
check(
  "the Staging Base URL placeholder previews the derived dev host",
  placeholder === "https://dev.asapsemi.com",
  placeholder
);

// The field is NOT gated on the current mode: a session created at 1.90 must
// still be able to carry a staging URL for later.
check(
  "the Staging Base URL field is available while the toggle is at 1.90",
  await page.locator("#staging-base-url").isVisible()
);

await shoot(page, "01-toggle-1.90");

// Switching TO staging must confirm first — it is global and it costs stored
// production results.
await stagingBtn.click();
await page.waitForSelector("text=Send URL checks to staging?", { timeout: 10000 });

const dialogText = await page.locator("[role=dialog]").innerText();
check(
  "the confirm dialog states the blast radius",
  /downloads and publishing are\s+unaffected/i.test(dialogText.replace(/\s+/g, " ")) ||
    /unaffected/i.test(dialogText)
);
check(
  "the confirm dialog warns that production results are replaced",
  /replace its stored production\s+results/i.test(
    dialogText.replace(/\s+/g, " ")
  ) || /replace/i.test(dialogText)
);
check(
  "the confirm dialog says the setting is global",
  /global/i.test(dialogText)
);

await shoot(page, "02-confirm-dialog");

await page.locator("button", { hasText: "Switch to 2.0 · staging" }).click();
await page.waitForTimeout(2500);

const state = await page.evaluate(() =>
  fetch("/api/backend/api/settings/url-check-mode").then((r) => r.json())
);
check("confirming actually persists 2.0 server-side", state.mode === "2.0", state.mode);

await shoot(page, "03-toggle-2.0");

// Leave the deployment as it was found. A test that silently leaves every check
// pointed at staging would be worse than no test.
await page.evaluate(() =>
  fetch("/api/backend/api/settings/url-check-mode", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "1.90" })
  })
);

await browser.close();

const failed = results.filter((r) => !r.pass);

console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
