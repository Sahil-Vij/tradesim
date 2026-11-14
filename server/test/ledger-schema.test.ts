import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type pg from "pg";
import { migrate } from "../src/db/migrate.ts";
import { createTestPool, skipWithoutDb } from "./db.ts";

describe("ledger schema", { skip: skipWithoutDb }, () => {
  let pool: pg.Pool;
  let drop: () => Promise<void>;
  let userId: bigint;
  let userInr: bigint;
  let houseInr: bigint;
  let userBtc: bigint;

  async function account(user: bigint | null, kind: string, asset: string): Promise<bigint> {
    const { rows } = await pool.query(
      "INSERT INTO accounts (user_id, kind, asset) VALUES ($1, $2, $3) RETURNING id",
      [user, kind, asset],
    );
    return rows[0].id;
  }

  before(async () => {
    ({ pool, drop } = await createTestPool());
    await migrate(pool);
    const { rows } = await pool.query(
      "INSERT INTO users (email, password_hash) VALUES ('a@example.com', 'x') RETURNING id",
    );
    userId = rows[0].id;
    userInr = await account(userId, "cash", "INR");
    houseInr = await account(null, "house", "INR");
    userBtc = await account(userId, "holding", "BTC");
  });
  after(() => drop());

  /** Posts an entry in one transaction, so the deferred balance check runs at commit. */
  async function post(lines: Array<[account: bigint, asset: string, amount: bigint]>): Promise<bigint> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query("INSERT INTO journal_entries (kind) VALUES ('test') RETURNING id");
      const entry: bigint = rows[0].id;
      for (const [accountId, asset, amount] of lines) {
        await client.query(
          "INSERT INTO journal_lines (entry_id, account_id, asset, amount) VALUES ($1, $2, $3, $4)",
          [entry, accountId, asset, amount],
        );
      }
      await client.query("COMMIT");
      return entry;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  test("a balanced entry commits, and BIGINT comes back as BigInt", async () => {
    const entry = await post([
      [houseInr, "INR", -100_000_000n],
      [userInr, "INR", 100_000_000n],
    ]);
    const { rows } = await pool.query(
      "SELECT amount FROM journal_lines WHERE entry_id = $1 ORDER BY amount",
      [entry],
    );
    assert.deepEqual(rows.map((r) => r.amount), [-100_000_000n, 100_000_000n]);
  });

  test("an unbalanced entry is rejected at commit", async () => {
    await assert.rejects(
      post([
        [houseInr, "INR", -500n],
        [userInr, "INR", 499n],
      ]),
      /does not balance for INR/,
    );
  });

  test("lines must balance per asset, not just in total", async () => {
    // Sums to zero overall, but takes 500 paise from the house and hands out 500 units of BTC.
    await assert.rejects(
      post([
        [houseInr, "INR", -500n],
        [userBtc, "BTC", 500n],
      ]),
      /does not balance/,
    );
  });

  test("a line can't carry a different asset from its account", async () => {
    await assert.rejects(
      post([
        [houseInr, "USD", -1n],
        [userInr, "USD", 1n],
      ]),
      /foreign key/,
    );
  });

  test("zero-amount lines are rejected", async () => {
    await assert.rejects(post([[userInr, "INR", 0n]]), /check constraint/);
  });

  test("journal entries and lines can't be edited or deleted", async () => {
    const entry = await post([
      [houseInr, "INR", -1n],
      [userInr, "INR", 1n],
    ]);
    await assert.rejects(
      pool.query("UPDATE journal_lines SET amount = 2 WHERE entry_id = $1", [entry]),
      /append-only/,
    );
    await assert.rejects(pool.query("DELETE FROM journal_lines WHERE entry_id = $1", [entry]), /append-only/);
    await assert.rejects(pool.query("UPDATE journal_entries SET kind = 'x' WHERE id = $1", [entry]), /append-only/);
  });

  test("a user balance can't go negative, but the house can", async () => {
    await assert.rejects(
      pool.query("UPDATE accounts SET balance = -1 WHERE id = $1", [userInr]),
      /accounts_user_balance_not_negative/,
    );
    await pool.query("UPDATE accounts SET balance = -1 WHERE id = $1", [houseInr]);
  });

  test("one account per user, kind and asset, and one house account per asset", async () => {
    await assert.rejects(account(userId, "cash", "INR"), /accounts_one_per_kind_and_asset/);
    await assert.rejects(account(null, "house", "INR"), /accounts_one_per_kind_and_asset/);
  });

  test("house accounts have no user, and user accounts can't be house accounts", async () => {
    await assert.rejects(account(null, "cash", "USD"), /accounts_house_has_no_user/);
    await assert.rejects(account(userId, "house", "USD"), /accounts_house_has_no_user/);
  });

  test("emails are stored lowercase and unique", async () => {
    await assert.rejects(
      pool.query("INSERT INTO users (email, password_hash) VALUES ('B@example.com', 'x')"),
      /users_email_lowercase/,
    );
    await assert.rejects(
      pool.query("INSERT INTO users (email, password_hash) VALUES ('a@example.com', 'x')"),
      /users_email_key/,
    );
  });
});
