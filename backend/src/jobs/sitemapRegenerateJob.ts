import { unlink } from "node:fs/promises";

import type { FastifyBaseLogger } from "fastify";

import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { markSessionComplete } from "./sessionCompletion.js";
import { productionFilename } from "../sitemaps/filenames.js";
import { pathMatchesTemplate } from "../sitemaps/rewriteLocs.js";
import { streamSitemapUrlLocs } from "../sitemaps/parser.js";
import {
  parseStructure,
  transformUrl,
  type ParsedStructure
} from "../sitemaps/transformStructure.js";
import { pickCollisionFreeTemplate } from "../sitemaps/outputFilenamePattern.js";
import {
  writeSitemapChunks,
  type SitemapChunkPlan
} from "../sitemaps/sitemapChunkFiles.js";
import type { SitemapGenerateUrl } from "../workers/sitemapGenerateWorker.js";
import { withPublishLock } from "../publish/publishLock.js";
import { resolvePublishTarget } from "../publish/publishTarget.js";
import { buildPublishPlan, executePublish } from "../publish/s3Publish.js";

// The sitemap-regenerate wizard's job: apply each pattern's as-is/rewrite
// decision to the CSV-derived URL population, chunk the result into
// <=50,000-URL files under the user's filename template, replace the site's
// current sitemap content with them, then publish — one traceable unit, one
// job row, modeled on jobs/lastmodUpdateJob.ts (status moves PENDING ->
// RUNNING -> PUBLISHING -> COMPLETE/FAILED, rewrite in one transaction,
// publish reuses the exact plan/execute path an ordinary publish uses).
//
// UNLIKE lastmodUpdateJob.ts, the superseded old current files are NOT
// unlinked after commit — they stay on local disk (soft-deleted in the
// database, so excluded from the index and from any further publish) until
// the ordinary cleanup-uploads sweep removes them. That sweep is re-armed
// below with a 24h override instead of the global 48h default, because for
// THIS wizard those local copies are the actual rollback point, not a mere
// courtesy window — see config.sitemapRegenerateCleanupDelayMs.

const CHUNK_SIZE = 50_000;

export const SITEMAP_REGENERATE_LASTMOD_POLICIES = ["all", "rewritten_only"] as const;
export type SitemapRegenerateLastmodPolicy =
  (typeof SITEMAP_REGENERATE_LASTMOD_POLICIES)[number];

export type PatternDecision =
  | { pattern_id: string; mode: "as_is" }
  | {
      pattern_id: string;
      mode: "rewrite";
      current_structure: string;
      new_structure: string;
    };

type JobParams = {
  csv_sitemap_file_id: string;
  pattern_decisions: PatternDecision[];
  filename_template: string;
  lastmod_policy: SitemapRegenerateLastmodPolicy;
};

type JobRow = {
  session_id: string;
  params: JobParams;
};

async function loadJob(jobRowId: string, logger: FastifyBaseLogger) {
  const result = await pool.query<JobRow>(
    "SELECT session_id, params FROM sitemap_regenerate_jobs WHERE id = $1",
    [jobRowId]
  );

  if (result.rowCount === 0) {
    logger.warn({ job_row_id: jobRowId }, "sitemap regenerate job: row missing");

    return null;
  }

  await pool.query(
    "UPDATE sitemap_regenerate_jobs SET status = 'RUNNING' WHERE id = $1",
    [jobRowId]
  );

  return result.rows[0];
}

async function markFailed(jobRowId: string, message: string) {
  await pool.query(
    `
      UPDATE sitemap_regenerate_jobs
      SET status = 'FAILED', error = $2, completed_at = now()
      WHERE id = $1
    `,
    [jobRowId, message]
  );
}

async function markComplete(jobRowId: string, result: unknown) {
  await pool.query(
    `
      UPDATE sitemap_regenerate_jobs
      SET status = 'COMPLETE', result = $2, completed_at = now()
      WHERE id = $1
    `,
    [jobRowId, JSON.stringify(result)]
  );
}

async function setCounts(
  jobRowId: string,
  counts: { urlsTotal: number; filesTotal: number }
) {
  await pool.query(
    `
      UPDATE sitemap_regenerate_jobs
      SET urls_total = $2, files_total = $3
      WHERE id = $1
    `,
    [jobRowId, counts.urlsTotal, counts.filesTotal]
  );
}

async function finishCounts(
  jobRowId: string,
  counts: { urlsWritten: number; filesDone: number }
) {
  await pool.query(
    `
      UPDATE sitemap_regenerate_jobs
      SET urls_written = $2, files_done = $3
      WHERE id = $1
    `,
    [jobRowId, counts.urlsWritten, counts.filesDone]
  );
}

type ResolvedUrl = {
  loc: string;
  rewritten: boolean;
};

// Apply every pattern's decision to the CSV-derived legacy file's URLs in ONE
// streaming pass — cheap enough to do this way (one file, not the general
// "scan every file for every pattern" problem enumeratePopulation solves,
// which is also hard-coded to source_role='current' and so cannot be reused
// here at all). "First matching template wins" mirrors enumeratePopulation's
// own rule for the same reason: a URL's path shape should match at most one
// extracted pattern anyway, since extraction partitions by segment count and
// static-segment shape, but ties are broken deterministically rather than
// left to iteration order.
async function resolveFinalUrls(
  csvStoredFilename: string,
  decisions: PatternDecision[],
  patternTemplates: Map<string, string>,
  logger: FastifyBaseLogger
): Promise<{ urls: ResolvedUrl[]; unclassifiedCount: number; unresolvedRewriteCount: number }> {
  const parsedByPatternId = new Map<
    string,
    { current: ParsedStructure; next: ParsedStructure }
  >();

  for (const decision of decisions) {
    if (decision.mode === "rewrite") {
      parsedByPatternId.set(decision.pattern_id, {
        current: parseStructure(decision.current_structure),
        next: parseStructure(decision.new_structure)
      });
    }
  }

  const orderedDecisions = decisions
    .map((decision) => {
      const template = patternTemplates.get(decision.pattern_id);

      return template ? { decision, template } : null;
    })
    .filter(
      (entry): entry is { decision: PatternDecision; template: string } =>
        entry !== null
    );

  const urls: ResolvedUrl[] = [];
  let unclassifiedCount = 0;
  let unresolvedRewriteCount = 0;

  await streamSitemapUrlLocs(csvStoredFilename, (loc) => {
    let pathname: string;

    try {
      pathname = new URL(loc).pathname;
    } catch {
      return;
    }

    const matched = orderedDecisions.find((entry) =>
      pathMatchesTemplate(pathname, entry.template)
    );

    if (!matched) {
      unclassifiedCount += 1;
      urls.push({ loc, rewritten: false });
      return;
    }

    if (matched.decision.mode === "as_is") {
      urls.push({ loc, rewritten: false });
      return;
    }

    const parsed = parsedByPatternId.get(matched.decision.pattern_id);
    const transformed = parsed ? transformUrl(loc, parsed.current, parsed.next) : null;

    if (!transformed || transformed === loc) {
      // The example-derived rule didn't apply to this particular URL (a
      // shape the by-example preview didn't see) — keep the original rather
      // than dropping the URL from the site entirely.
      unresolvedRewriteCount += 1;
      urls.push({ loc, rewritten: false });
      return;
    }

    urls.push({ loc: transformed, rewritten: true });
  });

  if (unclassifiedCount > 0) {
    logger.info(
      { unclassified_count: unclassifiedCount },
      "sitemap regenerate job: some CSV URLs matched no decided pattern, kept as-is"
    );
  }

  return { urls, unclassifiedCount, unresolvedRewriteCount };
}

function chunkUrls(urls: ResolvedUrl[]): ResolvedUrl[][] {
  if (urls.length === 0) {
    return [];
  }

  const chunks: ResolvedUrl[][] = [];

  for (let start = 0; start < urls.length; start += CHUNK_SIZE) {
    chunks.push(urls.slice(start, start + CHUNK_SIZE));
  }

  return chunks;
}

function buildGenerateUrls(
  chunk: ResolvedUrl[],
  lastmodPolicy: SitemapRegenerateLastmodPolicy,
  today: string
): SitemapGenerateUrl[] {
  return chunk.map((entry) => ({
    loc: entry.loc,
    lastmod: lastmodPolicy === "all" || entry.rewritten ? today : null
  }));
}

async function existingCurrentDisplayFilenames(
  sessionId: string
): Promise<{
  displayNames: Set<string>;
  oldContentRows: { id: string; filename: string }[];
}> {
  const result = await pool.query<{
    id: string;
    filename: string;
    original_filename: string | null;
    is_index: boolean;
    is_regenerate_output: boolean;
  }>(
    `
      SELECT id, filename, original_filename, is_index, is_regenerate_output
      FROM sitemap_files
      WHERE session_id = $1 AND source_role = 'current' AND is_deleted = false
    `,
    [sessionId]
  );

  const displayNames = new Set<string>();
  const oldContentRows: { id: string; filename: string }[] = [];

  for (const row of result.rows) {
    displayNames.add(
      row.original_filename ?? productionFilename(sessionId, row.filename)
    );

    // Only THIS wizard's own previously-written chunk output is superseded on
    // a re-run. A file this session pulled for real from S3/SFTP during Step 1
    // is never a candidate here — soft-deleting it would drop it from the
    // republished index even though the CSV never touched it. See migration
    // 062.
    if (!row.is_index && row.is_regenerate_output) {
      oldContentRows.push({ id: row.id, filename: row.filename });
    }
  }

  return { displayNames, oldContentRows };
}

export async function processSitemapRegenerateJob(
  data: { session_id: string; job_row_id: string },
  logger: FastifyBaseLogger
): Promise<void> {
  const { job_row_id: jobRowId } = data;
  const job = await loadJob(jobRowId, logger);

  if (!job) {
    return;
  }

  const sessionId = job.session_id;
  const { csv_sitemap_file_id, pattern_decisions, filename_template, lastmod_policy } =
    job.params;

  logger.info(
    { session_id: sessionId, job_row_id: jobRowId },
    "sitemap regenerate job started"
  );

  try {
    const csvFileResult = await pool.query<{ filename: string }>(
      "SELECT filename FROM sitemap_files WHERE id = $1 AND session_id = $2",
      [csv_sitemap_file_id, sessionId]
    );

    if (csvFileResult.rowCount === 0) {
      throw new Error("The uploaded CSV's sitemap file could not be found.");
    }

    const patternsResult = await pool.query<{ id: string; template: string }>(
      `
        SELECT id, template
        FROM patterns
        WHERE session_id = $1 AND source_role = 'legacy'
          AND id = ANY($2::uuid[])
      `,
      [sessionId, pattern_decisions.map((decision) => decision.pattern_id)]
    );
    const patternTemplates = new Map(
      patternsResult.rows.map((row) => [row.id, row.template])
    );

    const { urls, unclassifiedCount, unresolvedRewriteCount } = await resolveFinalUrls(
      csvFileResult.rows[0].filename,
      pattern_decisions,
      patternTemplates,
      logger
    );

    const chunkedUrls = chunkUrls(urls);

    if (chunkedUrls.length === 0) {
      throw new Error("The CSV's URLs resolved to nothing to regenerate.");
    }

    const { displayNames: existingDisplayNames, oldContentRows } =
      await existingCurrentDisplayFilenames(sessionId);

    const { filenames } = pickCollisionFreeTemplate(
      filename_template,
      chunkedUrls.length,
      existingDisplayNames
    );

    await setCounts(jobRowId, {
      urlsTotal: urls.length,
      filesTotal: chunkedUrls.length
    });

    const today = new Date().toISOString().slice(0, 10);
    const chunkPlans: SitemapChunkPlan[] = chunkedUrls.map((chunk, index) => ({
      displayFilename: filenames[index],
      urls: buildGenerateUrls(chunk, lastmod_policy, today)
    }));

    const client = await pool.connect();
    let writtenChunks: Awaited<ReturnType<typeof writeSitemapChunks>> = [];
    let committed = false;

    try {
      await client.query("BEGIN");

      if (oldContentRows.length > 0) {
        await client.query(
          `
            UPDATE sitemap_files
            SET is_deleted = true
            WHERE id = ANY($1::uuid[])
          `,
          [oldContentRows.map((row) => row.id)]
        );
      }

      writtenChunks = await writeSitemapChunks(client, sessionId, chunkPlans);

      await client.query("COMMIT");
      committed = true;
    } catch (error) {
      if (!committed) {
        await client.query("ROLLBACK").catch(() => {});
      }

      for (const chunk of writtenChunks) {
        await unlink(chunk.localPath).catch(() => {});
      }

      throw error;
    } finally {
      client.release();
    }

    // Deliberately NOT unlinking oldContentRows' files here — they stay on
    // local disk as this wizard's 24h rollback safety net (see this module's
    // header comment). The ordinary cleanup-uploads sweep removes them.

    const urlsWritten = writtenChunks.reduce((sum, chunk) => sum + chunk.urlCount, 0);

    await finishCounts(jobRowId, {
      urlsWritten,
      filesDone: writtenChunks.length
    });

    logger.info(
      {
        session_id: sessionId,
        job_row_id: jobRowId,
        files_written: writtenChunks.length,
        urls_written: urlsWritten,
        unclassified_count: unclassifiedCount,
        unresolved_rewrite_count: unresolvedRewriteCount
      },
      "sitemap regenerate job: files written"
    );

    await pool.query(
      "UPDATE sitemap_regenerate_jobs SET status = 'PUBLISHING' WHERE id = $1",
      [jobRowId]
    );

    if (!config.awsPublishEnabled) {
      await markFailed(
        jobRowId,
        `Generated ${writtenChunks.length} sitemap file(s) (${urlsWritten} URL(s)), but S3 publish is disabled on this deployment (AWS_PUBLISH_ENABLED is not true).`
      );

      return;
    }

    try {
      const target = await resolvePublishTarget(sessionId);

      await withPublishLock(target.prefixDomain, async () => {
        const plan = await buildPublishPlan(sessionId, target);
        const publishResult = await executePublish(plan, { today });

        await markComplete(jobRowId, {
          files_written: writtenChunks.length,
          urls_written: urlsWritten,
          unclassified_count: unclassifiedCount,
          unresolved_rewrite_count: unresolvedRewriteCount,
          filenames: writtenChunks.map((chunk) => chunk.displayFilename),
          published: {
            uploaded: publishResult.uploaded,
            bytes: publishResult.bytes,
            index_key: publishResult.index_key,
            failed_files: publishResult.failed_files,
            invalidation: publishResult.invalidation
          }
        });
      });

      // Re-arm the local-upload safety net with THIS wizard's shorter,
      // deliberate window rather than leaving whatever the CSV's own
      // extract/sample pass already armed (the global default) in place —
      // enqueueCleanupUploadsJob replaces a still-pending delayed job, so
      // this call's delay wins.
      await markSessionComplete(sessionId, {
        cleanupDelayMs: config.sitemapRegenerateCleanupDelayMs
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      logger.error(
        { session_id: sessionId, job_row_id: jobRowId, error },
        "sitemap regenerate job: publish failed after files were written"
      );
      await markFailed(
        jobRowId,
        `Generated ${writtenChunks.length} sitemap file(s) (${urlsWritten} URL(s)), but publishing to S3 failed: ${message}`
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    logger.error(
      { session_id: sessionId, job_row_id: jobRowId, error },
      "sitemap regenerate job failed"
    );
    await markFailed(jobRowId, message);
  }
}

// Exposed so the enqueue route's pre-flight estimate (patterns.total_urls ->
// files_total) uses the exact same chunk size this job actually chunks by.
export const SITEMAP_REGENERATE_CHUNK_SIZE = CHUNK_SIZE;
