import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

// Any fixed number works, as long as nothing else in the database uses it for an advisory lock.
const LOCK_ID = 7_300_001;
const FILE_NAME = /^(\d{3})_[a-z0-9_]+\.sql$/;

type Migration = { version: string; name: string; sql: string; checksum: string };

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const migrations: Migration[] = [];
  for (const name of files) {
    const match = FILE_NAME.exec(name);
    if (!match) throw new Error(`Migration file "${name}" must look like 001_short_name.sql`);
    const version = match[1]!;
    if (migrations.some((m) => m.version === version)) {
      throw new Error(`Two migrations share version ${version}`);
    }
    // Normalise line endings so a Windows checkout and a Linux one agree on the checksum.
    const sql = (await readFile(join(dir, name), "utf8")).replace(/\r\n/g, "\n");
    const checksum = createHash("sha256").update(sql).digest("hex");
    migrations.push({ version, name, sql, checksum });
  }
  return migrations;
}

/**
 * Applies pending migrations in order, each in its own transaction, and returns the names it applied.
 * Safe to call from several processes at once: an advisory lock makes them take turns.
 * Refuses to run if a migration that was already applied has since been edited.
 */
export async function migrate(pool: Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const migrations = await loadMigrations(dir);
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version    TEXT PRIMARY KEY,
          name       TEXT NOT NULL,
          checksum   TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      const { rows } = await client.query<{ version: string; name: string; checksum: string }>(
        "SELECT version, name, checksum FROM schema_migrations",
      );
      const applied = new Map(rows.map((r) => [r.version, r]));

      for (const [version, row] of applied) {
        const current = migrations.find((m) => m.version === version);
        if (!current) throw new Error(`Migration ${row.name} was applied but its file is missing`);
        if (current.checksum !== row.checksum) {
          throw new Error(
            `Migration ${current.name} was edited after it was applied. Add a new migration instead.`,
          );
        }
      }

      const ran: string[] = [];
      for (const m of migrations) {
        if (applied.has(m.version)) continue;
        await client.query("BEGIN");
        try {
          await client.query(m.sql);
          await client.query(
            "INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
            [m.version, m.name, m.checksum],
          );
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw new Error(`Migration ${m.name} failed: ${(err as Error).message}`, { cause: err });
        }
        ran.push(m.name);
      }
      return ran;
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]);
    }
  } finally {
    client.release();
  }
}
