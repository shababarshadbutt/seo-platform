import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  describeKind,
  patternStructureFingerprint
} from "./patternStructureJobClaim.js";

// The fingerprint is what makes "the user retried after their client timed out"
// distinguishable from "the user asked for something else". Getting it wrong in
// either direction is a real bug: too loose and a genuinely different transform is
// swallowed as a duplicate; too strict and the retry re-applies a rewrite that
// already succeeded (which, for a compounding `replace` rule, corrupts URLs).
// These are pure-function tests — the claim path itself needs a database, and this
// repo has no DB-backed route tests.

describe("patternStructureFingerprint", () => {
  it("is stable across calls with identical inputs", () => {
    const inputs = {
      current_structure: "/parts/{A}/{B}",
      new_structure: "/catalog/{A}/{B}/",
      new_template: null,
      source_files: ["b.xml", "a.xml"]
    };

    assert.equal(
      patternStructureFingerprint("TRANSFORM", inputs),
      patternStructureFingerprint("TRANSFORM", inputs)
    );
  });

  it("ignores the order of a file selection", () => {
    // The modal builds source_files from a Set, so the same selection can arrive
    // in a different order on the retry.
    assert.equal(
      patternStructureFingerprint("TRANSFORM", {
        source_files: ["a.xml", "b.xml", "c.xml"]
      }),
      patternStructureFingerprint("TRANSFORM", {
        source_files: ["c.xml", "a.xml", "b.xml"]
      })
    );
  });

  it("distinguishes a different target structure", () => {
    assert.notEqual(
      patternStructureFingerprint("TRANSFORM", {
        current_structure: "/parts/{A}",
        new_structure: "/catalog/{A}"
      }),
      patternStructureFingerprint("TRANSFORM", {
        current_structure: "/parts/{A}",
        new_structure: "/widgets/{A}"
      })
    );
  });

  it("distinguishes a different file selection", () => {
    assert.notEqual(
      patternStructureFingerprint("TRANSFORM", {
        source_files: ["a.xml"]
      }),
      patternStructureFingerprint("TRANSFORM", {
        source_files: ["a.xml", "b.xml"]
      })
    );
  });

  it("distinguishes the kind, so a rename and a transform never collide", () => {
    assert.notEqual(
      patternStructureFingerprint("RENAME", { new_template: "/x/{param}" }),
      patternStructureFingerprint("TRANSFORM", { new_template: "/x/{param}" })
    );
  });

  it("treats an absent optional field as distinct from a supplied one", () => {
    // A structure-only transform (no label change) must not be mistaken for one
    // that also renames the pattern.
    assert.notEqual(
      patternStructureFingerprint("TRANSFORM", { new_template: null }),
      patternStructureFingerprint("TRANSFORM", { new_template: "/x/{param}" })
    );
  });

  it("treats undefined and absent identically", () => {
    // `new_template: newTemplateRaw ?? null` in the route means an omitted field
    // arrives as null; an undefined must not hash to something a retry can't
    // reproduce.
    assert.equal(
      patternStructureFingerprint("TRANSFORM", {
        new_structure: "/a/{A}",
        new_template: undefined
      }),
      patternStructureFingerprint("TRANSFORM", { new_structure: "/a/{A}" })
    );
  });
});

describe("describeKind", () => {
  it("names each operation for the busy message", () => {
    assert.equal(describeKind("RENAME"), "a pattern rename");
    assert.equal(describeKind("TRANSFORM"), "a structure transform");
    assert.equal(describeKind("TRANSFORM_UNDO"), "a transform undo");
  });

  it("falls back rather than printing a raw enum at the user", () => {
    assert.equal(describeKind("SOMETHING_NEW"), "an operation");
  });
});
