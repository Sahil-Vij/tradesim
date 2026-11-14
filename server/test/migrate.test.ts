import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type pg from "pg";
import { loadMigrations, migrate } from "../src/db/migrate.ts";
import { createTestPool, skipWithoutDb } from "./db.ts";

async function migrationsDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tradesim-migrations-"));
  for (const [name, sql] of Object.entries(files)) await writeFile(join(dir, name), sql);
  return dir;
}

describe("loadMigrations", () => {
  test("sorts by file name and rejects badly named files", async () => {
    const dir = await migrationsDir({ "002_b.sql": "SELECT 2;", "001_a.sql": "SELECT 1;" });
    assert.deepEqual((await loadMigrations(dir)).map((m) => m.name), ["001_a.sql", "002_b.sql"]);
    await writeFile(join(dir, "3_bad.sql"), "SELECT 3;");
    await assert.rejects(loadMigrations(dir), /must look like 001_short_name\.sql/);
    await rm(dir, { recursive: true });
  });

  test("rejects two files with the same version", async () => {
    const dir = await migrationsDir({ "001_a.sql": "SELECT 1;", "001_b.sql": "SELECT 1;" });
    await assert.rejects(loadMigrations(dir), /share version 001/);
    await rm(dir, { recursive: true });
  });

  test("gives the same checksum for CRLF and LF line endings", async () => {
    const lf = await loadMigrations(await migrationsDir({ "001_a.sql": "SELECT 1;\nSELECT 2;\n" }));
    const crlf = await loadMigrations(await migrationsDir({ "001_a.sql": "SELECT 1;\r\nSELECT 2;\r\n" }));
    assert.equal(lf[0]!.checksum, crlf[0]!.checksum);
  });
});

describe("migrate", { skip: skipWithoutDb }, () => {
  let pool: pg.Pool;
  let drop: () => Promise<void>;
  // A fresh schema per test, since every test starts its own history at version 001.
  beforeEach(async () => {
    ({ pool, drop } = await createTestPool());
  });
  afterEach(() => drop());

  test("applies pending migrations once, in order", async () => {
    const dir = await migrationsDir({
      "001_create.sql": "CREATE TABLE things (id INT);",
      "002_seed.sql": "INSERT INTO things VALUES (1);",
    });
    assert.deepEqual(await migrate(pool, dir), ["001_create.sql", "002_seed.sql"]);
    assert.deepEqual(await migrate(pool, dir), []);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM things");
    assert.equal(rows[0].n, 1);

    await writeFile(join(dir, "003_more.sql"), "INSERT INTO things VALUES (2);");
    assert.deepEqual(await migrate(pool, dir), ["003_more.sql"]);
  });

  test("concurrent runs apply each migration exactly once", async () => {
    const dir = await migrationsDir({
      "001_create.sql": "CREATE TABLE races (id INT);",
      "002_seed.sql": "INSERT INTO races VALUES (1);",
    });
    // Without the advisory lock, all but one of these would fail on CREATE TABLE.
    const results = await Promise.all(Array.from({ length: 5 }, () => migrate(pool, dir)));
    assert.equal(results.flat().length, 2);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM races");
    assert.equal(rows[0].n, 1);
  });

  test("refuses to run when an applied migration was edited", async () => {
    const dir = await migrationsDir({ "001_create.sql": "CREATE TABLE edits (id INT);" });
    await migrate(pool, dir);
    await writeFile(join(dir, "001_create.sql"), "CREATE TABLE edits (id BIGINT);");
    await assert.rejects(migrate(pool, dir), /001_create\.sql was edited after it was applied/);
  });

  test("refuses to run when an applied migration's file is missing", async () => {
    const dir = await migrationsDir({ "001_create.sql": "CREATE TABLE gone (id INT);" });
    await migrate(pool, dir);
    await rm(join(dir, "001_create.sql"));
    await assert.rejects(migrate(pool, dir), /001_create\.sql was applied but its file is missing/);
  });

  test("a failing migration leaves nothing behind", async () => {
    const dir = await migrationsDir({
      "001_half.sql": "CREATE TABLE half (id INT); INSERT INTO nope VALUES (1);",
    });
    await assert.rejects(migrate(pool, dir), /001_half\.sql failed/);
    const { rows } = await pool.query("SELECT to_regclass('half') AS t");
    assert.equal(rows[0].t, null);
    const recorded = await pool.query("SELECT 1 FROM schema_migrations WHERE name = '001_half.sql'");
    assert.equal(recorded.rowCount, 0);
  });
});
