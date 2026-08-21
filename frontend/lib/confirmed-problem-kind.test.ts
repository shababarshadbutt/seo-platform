import { strict as assert } from "node:assert";
import { test } from "node:test";

import { confirmedProblemKind } from "./confirmed-problem-kind";

const ALL_PROBLEMS = [301, 302, 307, 308, 404];

test("a redirect-only pattern is all fixable — the reported case", () => {
  // 579,024 confirmed 301s, no 404s. The red delete button claimed all of them.
  const kind = confirmedProblemKind({
    statuses: ALL_PROBLEMS,
    counts: new Map([[301, 579024]])
  });

  assert.equal(kind.total, 579024);
  assert.equal(kind.notFixable, 0);
  assert.equal(kind.allFixable, true);
});

test("any 404 in the selection keeps the destructive framing", () => {
  // A 404 has nowhere to go, so delete IS the action and the button should look
  // like it.
  const kind = confirmedProblemKind({
    statuses: ALL_PROBLEMS,
    counts: new Map([
      [301, 5000],
      [404, 12]
    ])
  });

  assert.equal(kind.notFixable, 12);
  assert.equal(kind.allFixable, false);
});

test("404s OUTSIDE the selection do not make a redirect delete look dangerous", () => {
  // Someone selected the 301 chip. The pattern has 404s too, but this delete
  // would not touch them, so they must not colour this button.
  const kind = confirmedProblemKind({
    statuses: [301],
    counts: new Map([
      [301, 5000],
      [404, 900]
    ])
  });

  assert.equal(kind.total, 5000);
  assert.equal(kind.notFixable, 0);
  assert.equal(kind.allFixable, true);
});

test("an explicit 404 selection is not softened", () => {
  const kind = confirmedProblemKind({
    statuses: [404],
    counts: new Map([[404, 900]])
  });

  assert.equal(kind.allFixable, false);
});

test("nothing confirmed is not 'all fixable'", () => {
  // The button is disabled at 0 anyway; saying "all of these can be fixed" about
  // a pattern with no problems would be noise.
  const kind = confirmedProblemKind({
    statuses: ALL_PROBLEMS,
    counts: new Map()
  });

  assert.equal(kind.total, 0);
  assert.equal(kind.allFixable, false);
});
