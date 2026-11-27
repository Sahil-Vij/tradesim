import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Redis } from "ioredis";
import type pg from "pg";
import { createApp } from "../src/app.ts";
import { migrate } from "../src/db/migrate.ts";
import { driftedAccounts } from "../src/ledger.ts";
import { orderTotal } from "../src/orders/orders.ts";
import { saveTick } from "../src/prices/store.ts";
import { createTestPool, skipWithoutDb } from "./db.ts";
import { createTestRedis, skipWithoutRedis } from "./redis.ts";

test("order total is quantity × price / 10^14 in cents, rounded half up", () => {
  const coin = 100_000_000n; // 1 coin in 10^-8 units
  const dollars = (d: bigint) => d * 100_000_000n; // a price of $d in 10^-8 units
  assert.equal(orderTotal(coin, dollars(1_000n)), 100_000n); // 1 coin at $1,000 = 100,000¢
  assert.equal(orderTotal(coin / 2n, dollars(63_754n)), 3_187_700n);
  assert.equal(orderTotal(1_000n * coin, 5_924_000n), 5_924n); // 1,000 DOGE at $0.05924 = $59.24
  assert.equal(orderTotal(1n, 50_000_000n), 0n); // 0.00000001 coin at $0.50 = 0.00000005¢
  assert.equal(orderTotal(coin, 1_500_000n), 2n); // $0.015 → 1.5¢ → 2¢
  assert.equal(orderTotal(coin, 1_499_999n), 1n);
});

const skip = skipWithoutDb || skipWithoutRedis;

describe("POST /api/orders", { skip }, () => {
  let pool: pg.Pool;
  let drop: () => Promise<void>;
  let redis: Redis;
  let cleanup: () => Promise<void>;
  let server: Server;
  let base: string;
  let clock = 1_000_000;
  let users = 0;

  before(async () => {
    ({ pool, drop } = await createTestPool());
    await migrate(pool);
    ({ redis, cleanup } = createTestRedis());
    server = createApp({ pool, redis, now: () => clock, jwtSecret: "j".repeat(32), secureCookies: false }).listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all([drop(), cleanup()]);
  });

  // Every test gets fresh prices: BTC at $1,000 and DOGE at $0.05924, both 1 second old.
  beforeEach(async () => {
    clock += 60_000;
    await saveTick(redis, { symbol: "BTC", price: 100_000_000_000n, time: clock - 1_000 });
    await saveTick(redis, { symbol: "DOGE", price: 5_924_000n, time: clock - 1_000 });
  });

  async function signUp(): Promise<string> {
    const res = await fetch(`${base}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `trader${++users}@example.com`, password: "long enough" }),
    });
    return (await res.json()).accessToken;
  }

  function order(token: string, body: object, key: string | null = crypto.randomUUID()) {
    const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${token}` };
    if (key !== null) headers["idempotency-key"] = key;
    return fetch(`${base}/api/orders`, { method: "POST", headers, body: JSON.stringify(body) });
  }

  async function balances(token: string): Promise<Record<string, bigint>> {
    const { rows } = await pool.query<{ asset: string; balance: bigint }>(
      `SELECT a.asset, a.balance FROM accounts a
       WHERE a.user_id = (SELECT id FROM users WHERE email = $1) AND a.kind IN ('cash', 'holding') AND a.asset <> 'INR'`,
      [`trader${tokenUser.get(token)}@example.com`],
    );
    return Object.fromEntries(rows.map((r) => [r.asset, r.balance]));
  }
  const tokenUser = new Map<string, number>();
  async function trader() {
    const token = await signUp();
    tokenUser.set(token, users);
    return token;
  }

  const oneBtc = { symbol: "BTC", side: "buy", quantity: "100000000" };

  test("a market buy fills at the cached price and moves cash and coins in one entry", async () => {
    const token = await trader();
    const res = await order(token, { symbol: "BTC", side: "buy", quantity: "250000000" }); // 2.5 BTC
    assert.equal(res.status, 201);
    const { order: filled } = await res.json();
    assert.deepEqual(
      { ...filled, id: undefined, createdAt: undefined },
      {
        id: undefined,
        createdAt: undefined,
        symbol: "BTC",
        side: "buy",
        type: "market",
        status: "filled",
        quantity: "250000000",
        quantityDecimals: 8,
        price: "100000000000",
        priceDecimals: 8,
        total: "250000",
        currency: "USD",
      },
    );
    assert.deepEqual(await balances(token), { USD: 750_000n, BTC: 250_000_000n });
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM journal_lines l JOIN orders o ON o.entry_id = l.entry_id WHERE o.id = $1",
      [filled.id],
    );
    assert.equal(rows[0].n, 4);
  });

  test("a market sell gives the cash back, and can't sell coins you don't have", async () => {
    const token = await trader();
    await order(token, { symbol: "DOGE", side: "buy", quantity: "1000000000000" }); // 10,000 DOGE = $592.40
    const sell = await order(token, { symbol: "DOGE", side: "sell", quantity: "400000000000" }); // 4,000
    assert.equal(sell.status, 201);
    assert.equal((await sell.json()).order.total, "23696");
    assert.deepEqual(await balances(token), { USD: 1_000_000n - 59_240n + 23_696n, DOGE: 600_000_000_000n });

    const tooMany = await order(token, { symbol: "DOGE", side: "sell", quantity: "600000000001" });
    assert.equal(tooMany.status, 422);
    assert.deepEqual(await tooMany.json(), { error: "insufficient_holdings" });
    const never = await order(token, { symbol: "BTC", side: "sell", quantity: "100000000" });
    assert.deepEqual(await never.json(), { error: "insufficient_holdings" });
  });

  test("GET /api/holdings lists the coins held, and drops one sold to zero", async () => {
    const token = await trader();
    const get = async () =>
      (await (await fetch(`${base}/api/holdings`, { headers: { authorization: `Bearer ${token}` } })).json()).holdings;
    assert.deepEqual(await get(), []);
    await order(token, { symbol: "BTC", side: "buy", quantity: "150000000" });
    await order(token, { symbol: "DOGE", side: "buy", quantity: "10000000000" });
    assert.deepEqual(await get(), [
      { asset: "BTC", quantity: "150000000", decimals: 8 },
      { asset: "DOGE", quantity: "10000000000", decimals: 8 },
    ]);
    await order(token, { symbol: "DOGE", side: "sell", quantity: "10000000000" });
    assert.deepEqual(await get(), [{ asset: "BTC", quantity: "150000000", decimals: 8 }]);
    assert.equal((await fetch(`${base}/api/holdings`)).status, 401);
  });

  test("refuses to buy more than the wallet holds, and changes nothing", async () => {
    const token = await trader();
    const res = await order(token, { symbol: "BTC", side: "buy", quantity: "1000500000" }); // 10.005 BTC = $10,005
    assert.equal(res.status, 422);
    assert.deepEqual(await res.json(), { error: "insufficient_funds" });
    assert.deepEqual(await balances(token), { USD: 1_000_000n }); // the BTC account was rolled back too
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM orders o JOIN users u ON u.id = o.user_id WHERE u.email = $1", [
      `trader${users}@example.com`,
    ]);
    assert.equal(rows[0].n, 0);
  });

  test("refuses a price older than 10 seconds, or no price at all", async () => {
    const token = await trader();
    clock += 9_001; // BTC was 1s old, now 10.001s
    const res = await order(token, oneBtc);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "1");
    assert.deepEqual(await res.json(), { error: "price_unavailable" });

    await redis.hdel("prices:latest", "DOGE");
    const none = await order(token, { symbol: "DOGE", side: "buy", quantity: "10000000000" });
    assert.equal(none.status, 503);
  });

  test("refuses orders worth less than $1, so rounding can't hand out free coins", async () => {
    const token = await trader();
    const dust = await order(token, { symbol: "BTC", side: "buy", quantity: "1" }); // 0.06¢ would round to 0
    assert.equal(dust.status, 422);
    assert.deepEqual(await dust.json(), { error: "order_too_small" });
    const dollar = await order(token, { symbol: "BTC", side: "buy", quantity: "100000" }); // exactly $1
    assert.equal(dollar.status, 201);
  });

  test("validates the request", async () => {
    const token = await trader();
    const cases: Array<[object, string]> = [
      [{ ...oneBtc, symbol: "ETHX" }, "unknown_symbol"],
      [{ ...oneBtc, symbol: "btc" }, "unknown_symbol"],
      [{ ...oneBtc, side: "short" }, "invalid_side"],
      [{ ...oneBtc, quantity: 100000000 }, "invalid_quantity"],
      [{ ...oneBtc, quantity: "0" }, "invalid_quantity"],
      [{ ...oneBtc, quantity: "-5" }, "invalid_quantity"],
      [{ ...oneBtc, quantity: "1.5" }, "invalid_quantity"],
      [{ ...oneBtc, quantity: "1".repeat(19) }, "invalid_quantity"],
      [{ ...oneBtc, type: "stop" }, "unsupported_order_type"],
    ];
    for (const [body, error] of cases) {
      const res = await order(token, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.deepEqual(await res.json(), { error }, JSON.stringify(body));
    }
    for (const key of [null, "", "has space", "x".repeat(256)]) {
      const res = await order(token, oneBtc, key);
      assert.equal(res.status, 400, String(key));
      assert.deepEqual(await res.json(), { error: "idempotency_key_required" });
    }
    assert.equal((await fetch(`${base}/api/orders`, { method: "POST" })).status, 401);
  });

  test("repeating a key returns the original response and doesn't trade again", async () => {
    const token = await trader();
    const first = await order(token, oneBtc, "order-1");
    const firstBody = await first.text();
    clock += 30_000; // the price is stale now, but a replay doesn't need one
    const again = await order(token, oneBtc, "order-1");
    assert.equal(again.status, 201);
    assert.equal(again.headers.get("idempotent-replayed"), "true");
    assert.equal(first.headers.get("idempotent-replayed"), null);
    assert.equal(await again.text(), firstBody, "the same bytes, keys in the same order");
    assert.deepEqual(await balances(token), { USD: 900_000n, BTC: 100_000_000n });
  });

  test("the same key with a different order is a 422; another user's key is unrelated", async () => {
    const token = await trader();
    await order(token, oneBtc, "shared-key");
    const changed = await order(token, { ...oneBtc, quantity: "200000000" }, "shared-key");
    assert.equal(changed.status, 422);
    assert.deepEqual(await changed.json(), { error: "idempotency_key_reused" });

    const other = await trader();
    assert.equal((await order(other, oneBtc, "shared-key")).status, 201);
  });

  test("a failed order doesn't use up its key, so the retry can succeed", async () => {
    const token = await trader();
    clock += 60_000; // prices are a minute old
    assert.equal((await order(token, oneBtc, "retry-me")).status, 503);
    await saveTick(redis, { symbol: "BTC", price: 100_000_000_000n, time: clock });
    const retry = await order(token, oneBtc, "retry-me");
    assert.equal(retry.status, 201);
    assert.equal(retry.headers.get("idempotent-replayed"), null);
  });

  test("ten requests racing with one key place exactly one order", async () => {
    const token = await trader();
    const responses = await Promise.all(Array.from({ length: 10 }, () => order(token, oneBtc, "double-click")));
    const bodies = await Promise.all(responses.map((r) => r.json()));
    assert.deepEqual(
      responses.map((r) => r.status),
      Array(10).fill(201),
    );
    assert.equal(new Set(bodies.map((b) => b.order.id)).size, 1, "every response is the same order");
    assert.equal(responses.filter((r) => r.headers.get("idempotent-replayed") === null).length, 1);
    assert.deepEqual(await balances(token), { USD: 900_000n, BTC: 100_000_000n });
  });

  test("25 orders racing for $10,000: exactly the 10 affordable ones fill", async () => {
    const token = await trader();
    const responses = await Promise.all(Array.from({ length: 25 }, () => order(token, oneBtc))); // $1,000 each
    const statuses = responses.map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 201).length, 10);
    assert.equal(statuses.filter((s) => s === 422).length, 15);
    assert.deepEqual(await balances(token), { USD: 0n, BTC: 1_000_000_000n });
    const client = await pool.connect();
    try {
      assert.deepEqual(await driftedAccounts(client), []);
    } finally {
      client.release();
    }
  });
});
