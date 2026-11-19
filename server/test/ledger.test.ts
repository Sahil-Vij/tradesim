import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import type pg from "pg";
import { createApp } from "../src/app.ts";
import { migrate } from "../src/db/migrate.ts";
import {
  InsufficientFundsError,
  UnbalancedEntryError,
  accountFor,
  driftedAccounts,
  openWallets,
  postEntry,
  withTransaction,
} from "../src/ledger.ts";
import { createTestPool, skipWithoutDb } from "./db.ts";
import { offlineRedis } from "./redis.ts";

describe("ledger", { skip: skipWithoutDb }, () => {
  let pool: pg.Pool;
  let drop: () => Promise<void>;

  before(async () => {
    ({ pool, drop } = await createTestPool());
    await migrate(pool);
  });
  after(() => drop());

  let emails = 0;
  /** A user with their starting balances. */
  async function newUser(): Promise<bigint> {
    return withTransaction(pool, async (client) => {
      const { rows } = await client.query<{ id: bigint }>(
        "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id",
        [`user${++emails}@example.com`],
      );
      await openWallets(client, rows[0]!.id);
      return rows[0]!.id;
    });
  }

  const inrOf = (userId: bigint) => withTransaction(pool, (c) => accountFor(c, userId, "cash", "INR"));
  const balanceOf = async (accountId: bigint) =>
    (await pool.query<{ balance: bigint }>("SELECT balance FROM accounts WHERE id = $1", [accountId])).rows[0]!.balance;

  /** Moves rupees from a user to the house, as a purchase would. */
  async function spend(userId: bigint, paise: bigint): Promise<bigint> {
    return withTransaction(pool, async (client) => {
      const from = await accountFor(client, userId, "cash", "INR");
      const to = await accountFor(client, null, "house", "INR");
      return postEntry(client, {
        kind: "test",
        lines: [
          { accountId: from, amount: -paise },
          { accountId: to, amount: paise },
        ],
      });
    });
  }

  test("a new user starts with ₹10,00,000 and $10,000, paid in by the house", async () => {
    const user = await newUser();
    const { rows } = await pool.query(
      "SELECT asset, balance FROM accounts WHERE user_id = $1 AND kind = 'cash' ORDER BY asset",
      [user],
    );
    assert.deepEqual(rows, [
      { asset: "INR", balance: 10_00_000_00n },
      { asset: "USD", balance: 10_000_00n },
    ]);
    const { rows: entries } = await pool.query(
      `SELECT e.kind, count(*)::int AS lines FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
       WHERE e.id IN (SELECT entry_id FROM journal_lines JOIN accounts ON accounts.id = account_id WHERE user_id = $1)
       GROUP BY e.id`,
      [user],
    );
    assert.deepEqual(entries, [{ kind: "opening", lines: 4 }], "one entry, house and user lines for both currencies");
  });

  test("spending more than the balance fails and leaves nothing behind", async () => {
    const user = await newUser();
    const inr = await inrOf(user);
    const entriesBefore = (await pool.query("SELECT count(*)::int AS n FROM journal_entries")).rows[0].n;

    await assert.rejects(spend(user, 10_00_000_01n), InsufficientFundsError);

    assert.equal(await balanceOf(inr), 10_00_000_00n);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM journal_entries")).rows[0].n, entriesBefore);
    await spend(user, 10_00_000_00n);
    assert.equal(await balanceOf(inr), 0n, "spending exactly the balance is fine");
  });

  test("entries that don't sum to zero are refused before anything is written", async () => {
    const user = await newUser();
    await assert.rejects(
      withTransaction(pool, async (client) => {
        const inr = await accountFor(client, user, "cash", "INR");
        const house = await accountFor(client, null, "house", "INR");
        await postEntry(client, {
          kind: "test",
          lines: [
            { accountId: inr, amount: -100n },
            { accountId: house, amount: 99n },
          ],
        });
      }),
      UnbalancedEntryError,
    );
    await assert.rejects(
      withTransaction(pool, async (client) => {
        // Rupees out, dollars in: each asset has to balance on its own.
        const inr = await accountFor(client, user, "cash", "INR");
        const houseUsd = await accountFor(client, null, "house", "USD");
        await postEntry(client, {
          kind: "test",
          lines: [
            { accountId: inr, amount: -100n },
            { accountId: houseUsd, amount: 100n },
          ],
        });
      }),
      /off by -100 for INR/,
    );
  });

  test("parallel spends can't take the balance below zero", async () => {
    const user = await newUser();
    // Twenty ₹1,00,000 purchases at once against ₹10,00,000: exactly ten can succeed.
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => spend(user, 1_00_000_00n)));
    const failed = results.filter((r) => r.status === "rejected");
    assert.equal(results.length - failed.length, 10);
    for (const r of failed) assert.ok((r as PromiseRejectedResult).reason instanceof InsufficientFundsError);
    assert.equal(await balanceOf(await inrOf(user)), 0n);
  });

  test("entries touching the same accounts in opposite orders don't deadlock", async () => {
    const [a, b] = [await inrOf(await newUser()), await inrOf(await newUser())];
    const move = (from: bigint, to: bigint) =>
      withTransaction(pool, (client) =>
        postEntry(client, {
          kind: "test",
          lines: [
            { accountId: from, amount: -1_00n },
            { accountId: to, amount: 1_00n },
          ],
        }),
      );
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? move(a, b) : move(b, a))));
    assert.equal(await balanceOf(a), 10_00_000_00n);
    assert.equal(await balanceOf(b), 10_00_000_00n);
  });

  test("every cached balance matches the sum of its lines", async () => {
    // Runs last, over everything the tests above wrote.
    const client = await pool.connect();
    try {
      assert.deepEqual(await driftedAccounts(client), []);
    } finally {
      client.release();
    }
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM accounts WHERE user_id IS NOT NULL");
    assert.ok(rows[0].n >= 10, "the check covered real accounts");
  });
});

describe("GET /api/wallets", { skip: skipWithoutDb }, () => {
  let pool: pg.Pool;
  let drop: () => Promise<void>;
  let server: Server;
  let base: string;

  before(async () => {
    ({ pool, drop } = await createTestPool());
    await migrate(pool);
    server = createApp({ pool, redis: offlineRedis(), jwtSecret: "j".repeat(32), secureCookies: false }).listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await drop();
  });

  test("a user who just signed up sees both starting balances, as strings", async () => {
    const signup = await fetch(`${base}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "wallets@example.com", password: "long enough" }),
    });
    const { accessToken } = await signup.json();
    const res = await fetch(`${base}/api/wallets`, { headers: { authorization: `Bearer ${accessToken}` } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      wallets: [
        { asset: "INR", balance: "100000000", decimals: 2 },
        { asset: "USD", balance: "1000000", decimals: 2 },
      ],
    });
  });

  test("needs a signed-in user", async () => {
    assert.equal((await fetch(`${base}/api/wallets`)).status, 401);
  });

  test("a failed sign-up leaves no wallets behind", async () => {
    const body = JSON.stringify({ email: "twice@example.com", password: "long enough" });
    const init = { method: "POST", headers: { "content-type": "application/json" }, body };
    assert.equal((await fetch(`${base}/api/auth/signup`, init)).status, 201);
    assert.equal((await fetch(`${base}/api/auth/signup`, init)).status, 409);
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM accounts a JOIN users u ON u.id = a.user_id WHERE u.email = 'twice@example.com'",
    );
    assert.equal(rows[0].n, 2, "one INR and one USD account, not four");
  });
});
