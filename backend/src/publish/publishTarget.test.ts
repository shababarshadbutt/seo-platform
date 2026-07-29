import assert from "node:assert/strict";
import { test } from "node:test";

import { s3PrefixForDomain } from "../config.js";
import {
  publishTargetFromSession,
  PublishTargetError,
  type SessionPublishSource
} from "./publishTarget.js";

// Reproduction of the production incident, and proof that it cannot recur.
//
// What happened: a session's sitemaps were pulled over SFTP from the folder
// "fastenersprocurement.com", but the session's base_url had been entered as
// "https://www.fastenersprocurement.com". The publish prefix was built from
// base_url's host VERBATIM, so every file was written to
// sites/www.fastenersprocurement.com/sitemaps/ while
// sites/fastenersprocurement.com/sitemaps/ — the prefix production serves from —
// was left untouched and stale. The publish reported complete success.
//
// The assertions below compare the RESOLVED S3 KEYS, not the presence of a
// warning: the key string is the thing that decides which folder in the bucket
// receives the bytes.

const INCIDENT_FILE = "manufacturers.xml";

// The full object key a session would write for one file — the same composition
// executePublish performs (`${plan.prefix}${file.displayName}`).
function resolvedKey(session: SessionPublishSource): string {
  const target = publishTargetFromSession(session);

  return `${s3PrefixForDomain(target.prefixDomain)}${INCIDENT_FILE}`;
}

// The OLD behaviour, kept here as a negative control: the prefix straight off
// base_url's host with no normalization and no SFTP input. If this ever stops
// disagreeing with itself across the two spellings, the test below has lost its
// teeth and is passing for the wrong reason.
function preFixKey(baseUrl: string): string {
  return `${s3PrefixForDomain(new URL(baseUrl).host)}${INCIDENT_FILE}`;
}

test("NEGATIVE CONTROL: the pre-fix derivation really did split one site across two prefixes", () => {
  const wwwKey = preFixKey("https://www.fastenersprocurement.com");
  const bareKey = preFixKey("https://fastenersprocurement.com");

  assert.notEqual(
    wwwKey,
    bareKey,
    "the old base_url-verbatim derivation must be shown to diverge, or the fix below proves nothing"
  );
  assert.equal(
    wwwKey,
    "sites/www.fastenersprocurement.com/sitemaps/manufacturers.xml"
  );
  assert.equal(
    bareKey,
    "sites/fastenersprocurement.com/sitemaps/manufacturers.xml"
  );
});

test("the incident session and a bare-host session now resolve to the SAME S3 key", () => {
  // The incident: pulled from the bare folder, base_url typed with www.
  const incident = resolvedKey({
    sftp_domain: "fastenersprocurement.com",
    base_url: "https://www.fastenersprocurement.com"
  });

  // A session whose base_url is the bare host — what the user expected to hit.
  const bareBaseUrl = resolvedKey({
    sftp_domain: null,
    base_url: "https://fastenersprocurement.com"
  });

  assert.equal(
    incident,
    bareBaseUrl,
    "an SFTP session with a www base_url must write to the same key as a bare-host session"
  );

  // And the key is the bare-host one — the prefix production actually serves
  // from, not the www sibling the incident wrote to.
  assert.equal(
    incident,
    "sites/fastenersprocurement.com/sitemaps/manufacturers.xml"
  );
});

// The equality must hold across every spelling of the same site, not just the
// two in the incident — otherwise the next variant picks a third folder.
test("every spelling of one site resolves to one prefix", () => {
  const expected = "sites/fastenersprocurement.com/sitemaps/manufacturers.xml";

  const variants: SessionPublishSource[] = [
    // SFTP folder bare, base_url with www — the incident.
    {
      sftp_domain: "fastenersprocurement.com",
      base_url: "https://www.fastenersprocurement.com"
    },
    // SFTP folder WITH www, base_url bare — the incident inverted.
    {
      sftp_domain: "www.fastenersprocurement.com",
      base_url: "https://fastenersprocurement.com"
    },
    // Both with www.
    {
      sftp_domain: "www.fastenersprocurement.com",
      base_url: "https://www.fastenersprocurement.com"
    },
    // No SFTP source at all (manual upload / URL fetch), www base_url.
    { sftp_domain: null, base_url: "https://www.fastenersprocurement.com" },
    // No SFTP source, bare base_url.
    { sftp_domain: null, base_url: "https://fastenersprocurement.com" },
    // Mixed case, which normalizeHost also collapses.
    { sftp_domain: null, base_url: "https://WWW.FastenersProcurement.com" },
    // A trailing path and a port on base_url must not reach the key either
    // (hostname, not host).
    { sftp_domain: null, base_url: "https://www.fastenersprocurement.com:443/x" }
  ];

  for (const variant of variants) {
    assert.equal(
      resolvedKey(variant),
      expected,
      `must resolve to one prefix: ${JSON.stringify(variant)}`
    );
  }
});

// Requirement 1: the SFTP folder is the source of truth, so base_url cannot move
// the files even when it says something else entirely.
test("the SFTP source domain wins over base_url, not the other way round", () => {
  const target = publishTargetFromSession({
    sftp_domain: "fastenersprocurement.com",
    base_url: "https://something-else.example.com"
  });

  assert.equal(target.prefixDomain, "fastenersprocurement.com");
  assert.equal(target.source, "sftp");
  // The override is reported, not silent — the job logs it and the dialog shows it.
  assert.equal(target.baseUrlHostIgnored, "something-else.example.com");
});

// A www/non-www difference is NOT a disagreement worth flagging — it normalizes
// to the same prefix, so reporting it would train users to ignore the warning.
test("a www-only difference is not reported as an ignored host", () => {
  const target = publishTargetFromSession({
    sftp_domain: "fastenersprocurement.com",
    base_url: "https://www.fastenersprocurement.com"
  });

  assert.equal(target.baseUrlHostIgnored, null);
  assert.equal(target.source, "sftp");
});

// The public <loc> host is deliberately NOT normalized: a site that serves at
// www must not have its sitemap index point at a redirecting bare host. One
// storage prefix, real serving host.
test("the public host keeps its www even though the prefix drops it", () => {
  const target = publishTargetFromSession({
    sftp_domain: "fastenersprocurement.com",
    base_url: "https://www.fastenersprocurement.com"
  });

  assert.equal(target.prefixDomain, "fastenersprocurement.com");
  assert.equal(target.publicHost, "www.fastenersprocurement.com");
});

test("a session with neither an SFTP domain nor a usable base_url refuses to resolve", () => {
  for (const bad of [null, "", "not a url", "ftp://example.com/x"]) {
    assert.throws(
      () => publishTargetFromSession({ sftp_domain: null, base_url: bad }),
      PublishTargetError,
      `must refuse base_url ${JSON.stringify(bad)}`
    );
  }
});

// The value now comes from our own database rather than a request body, but it
// still lands in an S3 key prefix.
test("a stored domain that could escape the prefix is refused", () => {
  for (const bad of ["../../etc", "a/b", ".."]) {
    assert.throws(
      () => publishTargetFromSession({ sftp_domain: bad, base_url: null }),
      PublishTargetError,
      `must refuse sftp_domain ${JSON.stringify(bad)}`
    );
  }
});
