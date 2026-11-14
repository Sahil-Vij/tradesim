import { randomBytes } from "node:crypto";
import pg from "pg";
import { createPool } from "../src/db/pool.ts";

export const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

// Locally, database tests are skipped without a database. In CI that would hide them, so fail instead.
if (!DATABASE_URL && process.env.CI) {
  throw new Error("DATABASE_URL must be set in CI so the database tests run");
}
export const skipWithoutDb = DATABASE_URL
  ? false
  : "set DATABASE_URL or TEST_DATABASE_URL (run `docker compose up -d` and copy .env.example to .env)";

/** A pool whose connections all use a new, empty schema, so each test file starts clean. */
export async function createTestPool(): Promise<{ pool: pg.Pool; drop: () => Promise<void> }> {
  const schema = `test_${randomBytes(6).toString("hex")}`;
  const admin = createPool(DATABASE_URL!);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${schema}` });
  return {
    pool,
    drop: async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}
