import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkTemplateConflict,
  findConflictingPattern,
  isTemplateConflictError,
  planTemplateChanges,
  racedTemplateConflictRejection,
  TEMPLATE_CONFLICT_CONSTRAINT,
  templateConflictMessage
} from "./patternTemplateConflict.js";

// The reported bug: renaming or transforming a pattern onto a template another
// pattern in the same session+role already holds raised
// `duplicate key value violates unique constraint
// patterns_unique_template_per_session_role`, which the routes rethrew as a raw
// 500. These cover both layers of the guard — the pre-check that produces the
// message, and the raced-violation mapper that stops the constraint text escaping
// even when the pre-check is beaten to the UPDATE.

const SESSION = "11111111-1111-1111-1111-111111111111";
const EDITING = "22222222-2222-2222-2222-222222222222";
const OTHER = "33333333-3333-3333-3333-333333333333";

// Minimal stand-in for a Pool/PoolClient that records the SQL it was given, so
// the WHERE clause can be asserted rather than assumed.
function fakeExecutor(rows: { id: string; template: string }[]) {
  const calls: { sql: string; params: unknown[] }[] = [];

  return {
    calls,
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });

      return { rows, rowCount: rows.length };
    }
  };
}

// THE ORIGINAL BUG, at the point of decision: two patterns whose templates are
// made to collide. The pre-check must SEE the other pattern.
test("a colliding template is detected before the UPDATE runs", async () => {
  const executor = fakeExecutor([
    { id: OTHER, template: "/rfq/{A}/{B}/" }
  ]);

  const conflict = await findConflictingPattern(executor, {
    sessionId: SESSION,
    sourceRole: "current",
    template: "/rfq/{A}/{B}/",
    excludePatternId: EDITING
  });

  assert.ok(conflict, "the other pattern must be found");
  assert.equal(conflict.id, OTHER);

  // Scoped exactly like the constraint (session_id, source_role, template) and
  // excluding the row being edited — anything looser or tighter would either miss
  // a real collision or invent one.
  const [call] = executor.calls;
  assert.deepEqual(call.params, [
    SESSION,
    "current",
    "/rfq/{A}/{B}/",
    EDITING
  ]);
  assert.match(call.sql, /session_id = \$1/);
  assert.match(call.sql, /source_role = \$2/);
  assert.match(call.sql, /template = \$3/);
  assert.match(call.sql, /id <> \$4/);
});

test("no collision when nothing else holds the template", async () => {
  const executor = fakeExecutor([]);

  assert.equal(
    await findConflictingPattern(executor, {
      sessionId: SESSION,
      sourceRole: "current",
      template: "/rfq/{A}/",
      excludePatternId: EDITING
    }),
    null
  );
});

// Without the id exclusion, re-saving a pattern's own template would report a
// conflict with itself — the guard would block legitimate no-op updates.
test("the row being edited is excluded from the search", async () => {
  const executor = fakeExecutor([]);

  await findConflictingPattern(executor, {
    sessionId: SESSION,
    sourceRole: "current",
    template: "/same/",
    excludePatternId: EDITING
  });

  assert.equal(executor.calls[0].params[3], EDITING);
});

// The message is what the user sees instead of the constraint text. It must name
// the structure and say what to do about it.
test("the conflict message names the structure and the way out", () => {
  const message = templateConflictMessage("/rfq/{A}/{B}/");

  assert.match(message, /\/rfq\/\{A\}\/\{B\}\//);
  assert.match(message, /already uses/i);
  assert.match(message, /rename or remove/i);
  // Must not leak the DB's own vocabulary.
  assert.doesNotMatch(message, /duplicate key|constraint|violates/i);
});

// Layer two: the pre-check is a check-then-act, so a concurrent request can still
// reach the constraint. That must become the same 400, not a 500.
test("a raced unique violation on this constraint is recognised", () => {
  // Shaped like the pg error the driver actually throws.
  const pgError = Object.assign(
    new Error(
      `duplicate key value violates unique constraint "${TEMPLATE_CONFLICT_CONSTRAINT}"`
    ),
    { code: "23505", constraint: TEMPLATE_CONFLICT_CONSTRAINT }
  );

  assert.equal(isTemplateConflictError(pgError), true);
});

// Deliberately narrow: a different unique index failing is a different bug and
// must keep surfacing as a 500 rather than being mislabelled a name collision.
test("other errors are NOT treated as template conflicts", () => {
  assert.equal(
    isTemplateConflictError(
      Object.assign(new Error("dup"), {
        code: "23505",
        constraint: "sessions_pkey"
      })
    ),
    false,
    "23505 on another constraint must not be swallowed"
  );
  assert.equal(
    isTemplateConflictError(
      Object.assign(new Error("not null"), {
        code: "23502",
        constraint: TEMPLATE_CONFLICT_CONSTRAINT
      })
    ),
    false,
    "a different error class on the same constraint is not a conflict"
  );
  assert.equal(isTemplateConflictError(new Error("plain")), false);
  assert.equal(isTemplateConflictError(null), false);
  assert.equal(isTemplateConflictError(undefined), false);
  assert.equal(isTemplateConflictError("23505"), false);
});

// ---- The response the client actually receives ---------------------------
//
// This is the reported bug reproduced at the level that matters: two patterns
// whose templates collide must yield a 400 carrying a real message, NOT the 500
// that re-raised "duplicate key value violates unique constraint
// patterns_unique_template_per_session_role". The routes forward this object
// verbatim (reply.code(status).send(body)).

test("REPRODUCES THE BUG: a collision yields a clean 400, not a 500", async () => {
  // Pattern OTHER already holds "/rfq/{A}/{B}/" in this session+role; the user is
  // renaming/transforming pattern EDITING onto that exact template.
  const executor = fakeExecutor([{ id: OTHER, template: "/rfq/{A}/{B}/" }]);

  const rejection = await checkTemplateConflict(executor, {
    sessionId: SESSION,
    sourceRole: "current",
    template: "/rfq/{A}/{B}/",
    excludePatternId: EDITING
  });

  assert.ok(rejection, "the collision must be rejected, not passed to the UPDATE");
  assert.equal(rejection.status, 400, "must be a 400, never a 500");
  assert.equal(rejection.body.error, "Bad Request");
  assert.match(rejection.body.message, /\/rfq\/\{A\}\/\{B\}\//);
  assert.match(rejection.body.message, /rename or remove/i);
  // The whole point: the user never sees Postgres's wording.
  assert.doesNotMatch(
    rejection.body.message,
    /duplicate key|unique constraint|patterns_unique_template_per_session_role/i
  );
});

test("no collision returns null so the update proceeds", async () => {
  assert.equal(
    await checkTemplateConflict(fakeExecutor([]), {
      sessionId: SESSION,
      sourceRole: "current",
      template: "/rfq/{A}/",
      excludePatternId: EDITING
    }),
    null
  );
});

// The race the pre-check cannot close: two requests both pass it, one loses at the
// UPDATE. That loser must ALSO get the 400 rather than the raw constraint text.
test("a raced violation produces the same 400, not a 500", () => {
  const pgError = Object.assign(
    new Error(
      `duplicate key value violates unique constraint "${TEMPLATE_CONFLICT_CONSTRAINT}"`
    ),
    { code: "23505", constraint: TEMPLATE_CONFLICT_CONSTRAINT }
  );

  const rejection = racedTemplateConflictRejection(pgError, "/rfq/{A}/{B}/");

  assert.ok(rejection, "a raced violation must be converted, not rethrown");
  assert.equal(rejection.status, 400);
  assert.match(rejection.body.message, /rename or remove/i);
  assert.doesNotMatch(rejection.body.message, /duplicate key|unique constraint/i);
});

// An unrelated failure must return null so the route rethrows it — otherwise this
// guard would hide real 500s behind a misleading "rename it" message.
test("an unrelated error is not converted, so it still surfaces", () => {
  assert.equal(
    racedTemplateConflictRejection(new Error("connection terminated"), "/x/"),
    null
  );
  assert.equal(
    racedTemplateConflictRejection(
      Object.assign(new Error("dup"), {
        code: "23505",
        constraint: "sitemap_files_pkey"
      }),
      "/x/"
    ),
    null
  );
});

// ---- Batch changes: skip collisions, apply the rest ---------------------
//
// The trailing-slash fix rewrites many templates in ONE statement, so a single
// collision used to abort the entire apply. Templates are independent, so the
// colliding patterns are skipped and the rest applied.

test("THE COLLISION-SKIP CASE: /x is skipped when /x/ already exists", () => {
  // "/x" would become "/x/", which pattern B already holds. "/y" is unaffected.
  const existing = [
    { id: "a", sourceRole: "current", template: "/x" },
    { id: "b", sourceRole: "current", template: "/x/" },
    { id: "c", sourceRole: "current", template: "/y" }
  ];
  const wanted = [
    { id: "a", sourceRole: "current", template: "/x", next: "/x/" },
    { id: "c", sourceRole: "current", template: "/y", next: "/y/" }
  ];

  const { applied, skipped } = planTemplateChanges(wanted, existing);

  // Partial success: the non-colliding pattern is still fixed.
  assert.deepEqual(
    applied.map((change) => change.id),
    ["c"],
    "everything that CAN be slashed must still be slashed"
  );

  // And the skip is reported, naming the template that blocked it.
  assert.deepEqual(skipped, [
    {
      template: "/x",
      conflicting_template: "/x/",
      source_role: "current"
    }
  ]);
});

test("no collisions means everything applies and nothing is reported", () => {
  const existing = [
    { id: "a", sourceRole: "current", template: "/x" },
    { id: "b", sourceRole: "current", template: "/y" }
  ];
  const { applied, skipped } = planTemplateChanges(
    [
      { id: "a", sourceRole: "current", template: "/x", next: "/x/" },
      { id: "b", sourceRole: "current", template: "/y", next: "/y/" }
    ],
    existing
  );

  assert.equal(applied.length, 2);
  assert.deepEqual(skipped, []);
});

// A pattern being changed must not block its own target, and must free the
// template it is LEAVING — otherwise a whole-session slash of /a -> /a/ and
// /a/ -> /a/ style chains would report phantom collisions.
test("a pattern does not collide with itself, and vacates its old template", () => {
  const existing = [{ id: "a", sourceRole: "current", template: "/x" }];
  const { applied, skipped } = planTemplateChanges(
    [{ id: "a", sourceRole: "current", template: "/x", next: "/x/" }],
    existing
  );

  assert.equal(applied.length, 1, "its own row must not block it");
  assert.deepEqual(skipped, []);
});

// The constraint is per (session_id, source_role, template): the same template
// under a DIFFERENT role is not a collision, and treating it as one would skip
// legitimate work on comparison sessions.
test("the same template under a different source_role is not a collision", () => {
  const existing = [
    { id: "a", sourceRole: "current", template: "/x" },
    { id: "b", sourceRole: "new", template: "/x/" }
  ];
  const { applied, skipped } = planTemplateChanges(
    [{ id: "a", sourceRole: "current", template: "/x", next: "/x/" }],
    existing
  );

  assert.equal(applied.length, 1);
  assert.deepEqual(skipped, []);
});

// Two changes in one batch aiming at the same template: the first claims it, the
// second is skipped. Without this the statement itself would fail and take the
// whole apply with it — the exact failure being removed.
test("an in-batch collision skips the loser instead of failing the statement", () => {
  const existing = [
    { id: "a", sourceRole: "current", template: "/x" },
    { id: "b", sourceRole: "current", template: "/x " }
  ];
  const { applied, skipped } = planTemplateChanges(
    [
      { id: "a", sourceRole: "current", template: "/x", next: "/same/" },
      { id: "b", sourceRole: "current", template: "/x ", next: "/same/" }
    ],
    existing
  );

  assert.deepEqual(applied.map((change) => change.id), ["a"]);
  assert.deepEqual(skipped, [
    {
      template: "/x ",
      conflicting_template: "/same/",
      source_role: "current"
    }
  ]);
});

// The undo direction (strip) collides the same way, against a pattern the fix
// never touched — which is why the "already taken" set must span the whole
// session, not just the flagged rows.
test("stripping collides with an untouched unslashed pattern", () => {
  const existing = [
    { id: "a", sourceRole: "current", template: "/x/" }, // was slashed by the fix
    { id: "b", sourceRole: "current", template: "/x" } // never touched
  ];
  const { applied, skipped } = planTemplateChanges(
    [{ id: "a", sourceRole: "current", template: "/x/", next: "/x" }],
    existing
  );

  assert.deepEqual(applied, []);
  assert.deepEqual(skipped, [
    {
      template: "/x/",
      conflicting_template: "/x",
      source_role: "current"
    }
  ]);
});
