import { strict as assert } from "node:assert";
import { test } from "node:test";

import { siteDomainFromSftpDomain } from "./site-domain";

// THE FRICTION THIS REMOVES. Picking a client from the Cleaner's SFTP dropdown
// used to leave the Domain field empty, and that field decides which URLs are
// KEPT — so retyping a hostname that was already on screen was both busywork and
// the one keystroke that could silently drop an entire corpus as wrong-domain.

test("a bare registrable domain gets https:// and www.", () => {
  assert.equal(
    siteDomainFromSftpDomain("limitlessaerospace.com"),
    "https://www.limitlessaerospace.com"
  );
});

test("a domain that already says www. is not given a second one", () => {
  assert.equal(
    siteDomainFromSftpDomain("www.limitlessaerospace.com"),
    "https://www.limitlessaerospace.com"
  );
});

// "www.shop.example.com" is generally not a host that exists, so a folder that is
// already a subdomain is left as it is.
test("an existing subdomain is not prefixed with www.", () => {
  assert.equal(
    siteDomainFromSftpDomain("shop.example.com"),
    "https://shop.example.com"
  );
});

// The documented limitation, pinned so a future change to shouldPrependWww is a
// deliberate one: a multi-part public suffix looks like a subdomain here. The
// result is an origin the user can see and correct, never a fabricated host.
test("a multi-part public suffix is left without www. rather than guessed at", () => {
  assert.equal(siteDomainFromSftpDomain("example.co.uk"), "https://example.co.uk");
});

// The folder names come off a remote server, so nothing here controls how they
// are written.
test("a scheme, a trailing slash and a path are all tolerated", () => {
  for (const input of [
    "https://www.example.com",
    "http://www.example.com",
    "www.example.com/",
    "www.example.com/sitemaps",
    "  www.example.com  "
  ]) {
    assert.equal(
      siteDomainFromSftpDomain(input),
      "https://www.example.com",
      `${JSON.stringify(input)} should normalise to the same origin`
    );
  }
});

test("hosts are lower-cased", () => {
  assert.equal(
    siteDomainFromSftpDomain("WWW.Example.COM"),
    "https://www.example.com"
  );
});

// Re-selecting the blank "Select a domain…" option must be able to CLEAR the
// field, not write a half-formed value into it.
test("empty input yields empty output", () => {
  for (const input of ["", "   ", "https://", "/"]) {
    assert.equal(siteDomainFromSftpDomain(input), "");
  }
});
