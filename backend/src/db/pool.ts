import pg from "pg";

import { config } from "../config.js";

// Exported so /health can report the ceiling next to the live counts (v1.77).
// A second literal 10 in the response would drift from this one, and the whole
// point of reporting it is that "9 of 10 in use" and "9 of 50 in use" are
// different situations.
export const DB_POOL_MAX = 10;

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: DB_POOL_MAX
});

export async function closePool() {
  await pool.end();
}

