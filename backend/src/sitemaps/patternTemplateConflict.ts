// Guard for `patterns_unique_template_per_session_role`, the UNIQUE constraint on
// (session_id, source_role, template) added in migration 008.
//
// THE BUG THIS EXISTS FOR. Rename, transform (its optional label update) and
// transform-undo all ran `UPDATE patterns SET template = $1 WHERE id = $2` with
// nothing checking whether another pattern in the same session+role already held
// that template. When one did, Postgres raised the unique violation, the route's
// catch rolled back and rethrew, and the user was shown the raw constraint text
// —"duplicate key value violates unique constraint
// patterns_unique_template_per_session_role"— as a generic 500.
//
// WHY REJECT RATHER THAN MERGE. Rejecting is what the surrounding code already
// does with a rename that cannot work: the rename route 400s on
// "new_template must differ from the current template". Merging two patterns is a
// feature, not the fix for an unhandled error, and this schema has no place to put
// it: undo is one level deep and strictly per-pattern (pattern_renames /
// pattern_transforms rows keyed by pattern_id, popped LIFO, restoring files from
// paths recorded for that ONE pattern), so a merged pattern would have two undo
// stacks and no way to represent that — across four independent undo paths
// (rename, transform, bulk replace, trailing slash). It would also have to reparent
// pattern_urls and sampled_urls, recompute total_urls / redirect_pct /
// confidence_pct, and reconcile the comma-joined `source_file` column. None of that
// belongs in a 500-to-400 fix.
//
// TWO LAYERS, deliberately. The pre-check produces a good message, but it is a
// check-then-act: two concurrent requests can both pass it and one still hits the
// constraint. isTemplateConflictError lets the catch blocks turn that raced
// violation into the SAME 400 rather than a 500, so the raw constraint text can
// never reach a client by either route.

export const TEMPLATE_CONFLICT_CONSTRAINT =
  "patterns_unique_template_per_session_role";

// Structurally typed so both a Pool and a checked-out PoolClient satisfy it
// without importing pg's types into the call sites.
export type TemplateConflictQuery = {
  query: (
    sql: string,
    params: unknown[]
  ) => Promise<{ rows: { id: string; template: string }[]; rowCount: number | null }>;
};

export function templateConflictMessage(template: string): string {
  return (
    `Another pattern in this session already uses the structure "${template}" — ` +
    `rename or remove that pattern first.`
  );
}

// Is there a DIFFERENT pattern in the same session + source_role already holding
// this template? `excludePatternId` is the row being edited: without it, every
// no-op update would report a conflict with itself.
export async function findConflictingPattern(
  executor: TemplateConflictQuery,
  options: {
    sessionId: string;
    sourceRole: string;
    template: string;
    excludePatternId: string;
  }
): Promise<{ id: string; template: string } | null> {
  const result = await executor.query(
    `
      SELECT id, template
      FROM patterns
      WHERE session_id = $1
        AND source_role = $2
        AND template = $3
        AND id <> $4
      LIMIT 1
    `,
    [
      options.sessionId,
      options.sourceRole,
      options.template,
      options.excludePatternId
    ]
  );

  return (result.rowCount ?? 0) > 0 ? result.rows[0] : null;
}

// The exact HTTP response a collision produces. The helper owns this rather than
// each route rebuilding `reply.code(400).send(badRequest(...))`, for two reasons:
// five call sites cannot drift apart on the status or the wording, and the
// response the client actually receives becomes assertable in a unit test — this
// repo has no DB-backed route tests, so without it the only thing provable would
// be that a query was built, not that the user stops seeing a 500.
export type TemplateConflictRejection = {
  status: 400;
  body: { error: "Bad Request"; message: string };
};

export function templateConflictRejection(
  template: string
): TemplateConflictRejection {
  return {
    status: 400,
    body: { error: "Bad Request", message: templateConflictMessage(template) }
  };
}

// Pre-check + response in one step: returns the 400 to send, or null to proceed.
export async function checkTemplateConflict(
  executor: TemplateConflictQuery,
  options: {
    sessionId: string;
    sourceRole: string;
    template: string;
    excludePatternId: string;
  }
): Promise<TemplateConflictRejection | null> {
  const conflict = await findConflictingPattern(executor, options);

  return conflict === null ? null : templateConflictRejection(options.template);
}

// The raced-violation counterpart: returns the same 400 when `error` is this
// constraint failing, or null when it is anything else (which must keep
// propagating as a 500 — see isTemplateConflictError).
export function racedTemplateConflictRejection(
  error: unknown,
  template: string
): TemplateConflictRejection | null {
  return isTemplateConflictError(error)
    ? templateConflictRejection(template)
    : null;
}

// ---- Batch changes: skip the collisions, apply the rest ------------------
//
// The trailing-slash fix rewrites many templates in ONE UPDATE. Adding a slash to
// "/x" violates the constraint when a separate "/x/" pattern already exists, and
// because it was one statement, a single collision among thousands of patterns
// aborted the entire apply.
//
// Each pattern's template is independent of every other, so partial success is
// safe: the colliding ones are skipped and the rest applied, reported the way the
// Cleaner reports dropped files rather than failing all-or-nothing.
//
// Pure and synchronous — it plans from rows already fetched, so it adds no queries
// to a path that is already reading every pattern in the session.

export type TemplateChange = {
  id: string;
  sourceRole: string;
  // Current template, needed to name what was skipped.
  template: string;
  // Desired template.
  next: string;
};

export type SkippedTemplateChange = {
  // The pattern that was left alone.
  template: string;
  // The template it would have become, which another pattern already holds.
  conflicting_template: string;
  source_role: string;
};

function templateKey(sourceRole: string, template: string): string {
  // NUL separator: it cannot occur in a URL template, so the composite key is
  // unambiguous where "a" + "b" style concatenation would not be.
  return `${sourceRole}\u0000${template}`;
}

// Split a batch into the changes that can be applied and the ones that would
// collide. `existing` is every pattern in the session (id, sourceRole, template),
// including the ones being changed — their identity is what lets a template they
// are VACATING be reused.
export function planTemplateChanges<T extends TemplateChange>(
  changes: T[],
  existing: { id: string; sourceRole: string; template: string }[]
): { applied: T[]; skipped: SkippedTemplateChange[] } {
  const changingIds = new Set(changes.map((change) => change.id));
  // Keys held by patterns that are NOT moving. A pattern being changed does not
  // block its own target, and vacates its old template for someone else.
  const taken = new Set<string>();

  for (const row of existing) {
    if (!changingIds.has(row.id)) {
      taken.add(templateKey(row.sourceRole, row.template));
    }
  }

  const applied: T[] = [];
  const skipped: SkippedTemplateChange[] = [];

  for (const change of changes) {
    const key = templateKey(change.sourceRole, change.next);

    // Also catches two changes in the SAME batch aiming at one template: the
    // first claims it, later ones are skipped rather than both being written and
    // the statement failing.
    if (taken.has(key)) {
      skipped.push({
        template: change.template,
        conflicting_template: change.next,
        source_role: change.sourceRole
      });

      continue;
    }

    taken.add(key);
    applied.push(change);
  }

  return { applied, skipped };
}

// A raced unique violation on THIS constraint specifically. Deliberately narrow:
// 23505 on some other unique index is a different bug and must keep surfacing as
// a 500 rather than being mislabelled a template collision.
export function isTemplateConflictError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as { code?: unknown; constraint?: unknown };

  return (
    candidate.code === "23505" &&
    candidate.constraint === TEMPLATE_CONFLICT_CONSTRAINT
  );
}
