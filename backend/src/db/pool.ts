import pg from "pg";

import { config } from "../config.js";

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10
});

export async function closePool() {
  await pool.end();
}

