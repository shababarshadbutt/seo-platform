import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  parseHostsFile,
  privateHostMapSnapshot,
  privateIpForHost,
  resetPrivateHostMap
} from "./privateHostMap.js";

// The fixtures are taken from the map actually supplied for this feature, not invented:
// the four sites0N blocks list only `www.` forms while the server5/6/7 blocks list both
// spellings, and one hostname is claimed by two different boxes. Every rule below exists
// because of something in that real file.
const REAL_SAMPLE = `# BEGIN internal-prod-sites-server01 (10.0.61.203)
10.0.61.203 www.aeropartshub.com
10.0.61.203 www.aeroworld360.com
10.0.61.203 www.industrialworld360.com
# END internal-prod-sites-server01

# BEGIN internal-prod-sites-server02 (10.0.49.183)
10.0.49.183 www.accelerateindustrials.com
10.0.49.183 www.industrialworld360.com
# END internal-prod-sites-server02

# BEGIN internal-prod-sites-server5 (ip-10-0-50-234, private routing, no public egress)
# Generated from \`pm2 list\` on ip-10-0-50-234 (2026-08-04) - covers both bare and www forms
10.0.50.234 stackedindustrials.com
10.0.50.234 www.stackedindustrials.com
# END internal-prod-sites-server5
`;

const MAP_OPTIONS = { reloadSeconds: 60 };

function writeMap(contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "private-hosts-"));
  const file = path.join(dir, "private-hosts.conf");

  writeFileSync(file, contents, "utf8");

  return file;
}

test("parses the real supplied format — banners, comments, both host spellings", () => {
  const { entries, warnings } = parseHostsFile(REAL_SAMPLE);

  assert.equal(entries.get("www.aeropartshub.com"), "10.0.61.203");
  assert.equal(entries.get("www.accelerateindustrials.com"), "10.0.49.183");
  // Both spellings listed on the same IP: both stored, no complaint.
  assert.equal(entries.get("stackedindustrials.com"), "10.0.50.234");
  assert.equal(entries.get("www.stackedindustrials.com"), "10.0.50.234");
  // `# BEGIN ...` / `# END ...` banner lines are comments, not entries.
  assert.equal(entries.has("begin"), false);
  // The ONLY warning from this fixture is the genuine conflict.
  assert.equal(warnings.length, 1);
});

// THE FAILURE THIS PREVENTS: first-wins would have silently pinned this site to one of
// two servers, and a 200 from the wrong box is indistinguishable from a correct one.
test("a hostname claimed by TWO IPs is dropped from the map, not first-won", () => {
  const { entries, conflicts, warnings } = parseHostsFile(REAL_SAMPLE);

  assert.equal(entries.has("www.industrialworld360.com"), false);
  assert.deepEqual(conflicts.get("industrialworld360.com"), [
    "10.0.61.203",
    "10.0.49.183"
  ]);
  // The warning names BOTH addresses and both line numbers, so it is actionable
  // without opening the file.
  assert.match(warnings[0], /industrialworld360\.com/);
  assert.match(warnings[0], /10\.0\.61\.203 and 10\.0\.49\.183/);
  assert.match(warnings[0], /NOT routed privately/);
});

test("a conflict poisons the whole www-family, whichever spelling is asked for", () => {
  const file = writeMap(REAL_SAMPLE);

  resetPrivateHostMap();

  // Neither spelling routes: the ambiguity is about which server hosts THE SITE, so
  // the bare form must not sneak through the www fallback.
  assert.equal(
    privateIpForHost("www.industrialworld360.com", { file, ...MAP_OPTIONS }),
    null
  );
  assert.equal(
    privateIpForHost("industrialworld360.com", { file, ...MAP_OPTIONS }),
    null
  );
});

test("a conflict later in the file still removes an entry made earlier", () => {
  // The 10.0.61.203 entry is on line 1 and the collision only appears on line 3.
  const { entries, conflicts } = parseHostsFile(
    ["10.0.1.1 www.a.com", "10.0.1.1 www.b.com", "10.0.2.2 www.a.com"].join("\n")
  );

  assert.equal(entries.has("www.a.com"), false);
  assert.equal(entries.get("www.b.com"), "10.0.1.1");
  assert.equal(conflicts.has("a.com"), true);
});

test("the same host on the same IP twice is harmless — first wins, one warning", () => {
  const { entries, conflicts, warnings } = parseHostsFile(
    ["10.0.1.1 www.a.com", "10.0.1.1 www.a.com"].join("\n")
  );

  assert.equal(entries.get("www.a.com"), "10.0.1.1");
  assert.equal(conflicts.size, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /repeats the same IP/);
});

test("www fallback resolves in BOTH directions", () => {
  const file = writeMap(
    ["10.0.61.203 www.onlywww.com", "10.0.55.55 onlybare.com"].join("\n")
  );

  resetPrivateHostMap();

  // Mapped as www., asked for bare (the four sites0N blocks are all www-only).
  assert.deepEqual(privateIpForHost("onlywww.com", { file, ...MAP_OPTIONS }), {
    ip: "10.0.61.203",
    matchedVia: "www-fallback"
  });
  // Mapped bare, asked for www.
  assert.deepEqual(
    privateIpForHost("www.onlybare.com", { file, ...MAP_OPTIONS }),
    { ip: "10.0.55.55", matchedVia: "www-fallback" }
  );
  // An exact hit is reported as exact, so diagnostics can tell a fleet that matches
  // entirely by fallback (i.e. a map generated for the other spelling).
  assert.deepEqual(
    privateIpForHost("www.onlywww.com", { file, ...MAP_OPTIONS }),
    { ip: "10.0.61.203", matchedVia: "exact" }
  );
});

test("an arbitrary subdomain is NEVER assumed to be the same site", () => {
  const file = writeMap("10.0.61.203 www.example.com");

  resetPrivateHostMap();

  // shop.example.com is a different site; probing it privately would measure the
  // wrong pages. Only the www LABEL is collapsed.
  assert.equal(
    privateIpForHost("shop.example.com", { file, ...MAP_OPTIONS }),
    null
  );
});

test("hostname lookups are case-insensitive and ignore the map's own casing", () => {
  const file = writeMap("10.0.61.203 WWW.Example.COM");

  resetPrivateHostMap();

  assert.equal(
    privateIpForHost("www.EXAMPLE.com", { file, ...MAP_OPTIONS })?.ip,
    "10.0.61.203"
  );
});

test("unparseable lines become warnings, never silent drops", () => {
  const { entries, warnings } = parseHostsFile(
    [
      "not-an-ip www.a.com",
      "10.0.1.1",
      "10.0.1.1 https://www.b.com/x",
      "10.0.1.1 www.good.com"
    ].join("\n")
  );

  // A map that quietly holds 3 of 4 entries looks exactly like a working map.
  assert.equal(entries.size, 1);
  assert.equal(entries.get("www.good.com"), "10.0.1.1");
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /line 1: .*not an IP/);
  assert.match(warnings[1], /line 2: .*no hostname/);
  assert.match(warnings[2], /line 3: .*looks like a URL/);
});

test("a trailing comment on an entry line is stripped, not parsed as a hostname", () => {
  const { entries, warnings } = parseHostsFile(
    "10.0.1.1 www.a.com # was 10.0.9.9 until 2026-08"
  );

  assert.deepEqual([...entries.keys()], ["www.a.com"]);
  assert.equal(warnings.length, 0);
});

test("several hostnames on one line are all mapped", () => {
  const { entries } = parseHostsFile("10.0.1.1 a.com www.a.com b.com");

  assert.equal(entries.size, 3);
  assert.equal(entries.get("b.com"), "10.0.1.1");
});

// A laptop dev run has no production map file, and must not fail because of it.
test("a missing file is an inert feature, not an error", () => {
  resetPrivateHostMap();

  const file = path.join(tmpdir(), "definitely-not-here", "private-hosts.conf");

  assert.equal(privateIpForHost("www.a.com", { file, ...MAP_OPTIONS }), null);

  const snapshot = privateHostMapSnapshot({ file, ...MAP_OPTIONS });

  assert.equal(snapshot.present, false);
  assert.equal(snapshot.entryCount, 0);
});

test("the file is re-read when it changes, without a restart", () => {
  const file = writeMap("10.0.1.1 www.a.com");

  resetPrivateHostMap();

  assert.equal(privateIpForHost("www.a.com", { file, ...MAP_OPTIONS })?.ip, "10.0.1.1");

  // reloadSeconds: 0 forces the stat on the next call, which is what a test needs;
  // production polls at most once a minute.
  writeFileSync(file, "10.0.2.2 www.a.com\n10.0.2.2 www.b.com\n", "utf8");

  assert.equal(
    privateIpForHost("www.a.com", { file, reloadSeconds: 0 })?.ip,
    "10.0.2.2"
  );
  assert.equal(
    privateIpForHost("www.b.com", { file, reloadSeconds: 0 })?.ip,
    "10.0.2.2"
  );
});

test("the snapshot reports hosts per IP, conflicts and warnings for /api/private-routes", () => {
  const file = writeMap(REAL_SAMPLE);

  resetPrivateHostMap();

  const snapshot = privateHostMapSnapshot({ file, ...MAP_OPTIONS });

  assert.equal(snapshot.present, true);
  // 5 entries, not 6: the conflicted hostname is not in the map.
  assert.equal(snapshot.entryCount, 5);
  assert.deepEqual(snapshot.hostsByIp, {
    "10.0.61.203": 2,
    "10.0.49.183": 1,
    "10.0.50.234": 2
  });
  assert.deepEqual(Object.keys(snapshot.conflicts), ["industrialworld360.com"]);
  assert.equal(snapshot.warnings.length, 1);
});
