import { readdir, unlink } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import type { FastifyBaseLogger } from "fastify";

import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { resetParsedSitemapCount } from "./sessionCompletion.js";

export async function processCleanupUploadsJob(
  data: { session_id: string },
  logger: FastifyBaseLogger
) {
  const prefix = `${data.session_id}-`;
  let deletedFileCount = 0;

  let entries: Dirent[];

  try {
    entries = await readdir(config.uploadDir, {
      withFileTypes: true
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    entries = [];
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix)) {
      continue;
    }

    try {
      await unlink(path.join(config.uploadDir, entry.name));
      deletedFileCount += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  await pool.query(
    "UPDATE sessions SET uploads_cleaned_at = NOW() WHERE id = $1",
    [data.session_id]
  );

  // Drop the Redis parsed-count key now that the session is finalized and its
  // uploads are gone, rather than leaving it to expire on its 24h TTL.
  await resetParsedSitemapCount(data.session_id);

  logger.info(
    {
      session_id: data.session_id,
      deleted_file_count: deletedFileCount
    },
    "session upload files cleaned"
  );
}
