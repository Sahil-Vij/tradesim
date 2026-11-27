import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Redis } from "ioredis";
import type pg from "pg";
import { createApp } from "../src/app.ts";
import { migrate } from "../src/db/migrate.ts";
import { driftedAccounts, withTransaction } from "../src/ledger.ts";
import { cancelOrder, crosses, matchTick } from "../src/orders/limit.ts";
import { enqueueTick, matchQueue, startMatcher } from "../src/orders/matcher.ts";
import { saveTick } from "../src/prices/store.ts";
import { createTestPool, skipWithoutDb } from "./db.ts";
import { createTestRedis, REDIS_URL, skipWithoutRedis } from "./redis.ts";

const usd = (dollars: bigint) => dollars * 100_000_000n; // a price of $d in 10^-8 units
const coins = (n: bigint) => n * 100_000_000n;

test("a limit buy crosses at or below its limit, a limit sell at or above", () => {
  const limitPrice = usd(900n);
  assert.equal(crosses({ side: "buy", limitPrice }, usd(900n)), true);
  assert.equal(crosses({ side: "buy", limitPrice }, usd(899n)), true);
  assert.equal(crosses({ side: "buy", limitPrice }, usd(901n)), false);
  assert.equal(crosses({ side: "sell", limitPrice }, usd(900n)), true);
  assert.equal(crosses({ side: "sell", limitPrice }, usd(899n)), false);
  assert.equal(crosses({ side: "buy", limitPrice: null }, usd(1n)), false);
});

const skip = skipWithoutDb || skipWithoutRedis;

describe("limit orders", { skip }, () => {
  let pool: pg.Pool;
  let drop: () => Promise<void>;
  let redis: Redis;
  let cleanup: () => Promise<void>;
  let server: Server;
  let base: string;
  let users = 0;

  before(async () => {
    ({ pool, drop } = await createTestPool());
    await migrate(pool);
    ({ redis, cleanup } = createTestRedis());
    server = createApp({ pool, redis, jwtSecret: "j".repeat(32), secureCookies: false }).listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all([drop(), cleanup()]);
  });

  // Market orders in these tests buy BTC at $1,000.
  beforeEach(async () => {
    await saveTick(redis, { symbol: "BTC", price: usd(1_000n), time: Date.now() });
  });

  type Trader = { token: string; email: string };
  async function trader(): Promise<Trader> {
    const email = `limit${++users}@example.com`;
    const res = await fetch(`${base}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "long enough" }),
    });
    return { token: (await res.json()).accessToken, email };
  }

  function order(t: Trader, body: object, key: string = crypto.randomUUID()) {
    return fetch(`${base}/api/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${t.token}`, "idempotency-key": key },
      body: JSON.stringify(body),
    });
  }
  function cancel(t: Trader, id: string) {
    return fetch(`${base}/api/orders/${id}`, { method: "DELETE", headers: { authorization: `Bearer ${t.token}` } });
  }
  const limitBuy = (quantity: bigint, limit: bigint) => ({
    symbol: "BTC",
    side: "buy",
    type: "limit",
    quantity: String(quantity),
    limitPrice: String(limit),
  });

  /** USD and BTC balances by account kind, e.g. { "cash USD": 1000000n, "hold USD": 0n }. */
  async function balances(t: Trader): Promise<Record<string, bigint>> {
    const { rows } = await pool.query<{ kind: string; asset: string; balance: bigint }>(
      `SELECT kind, asset, balance FROM accounts
       WHERE user_id = (SELECT id FROM users WHERE email = $1) AND asset <> 'INR' ORDER BY kind, asset`,
      [t.email],
    );
    return Object.fromEntries(rows.map((r) => [`${r.kind} ${r.asset}`, r.balance]));
  }
  async function status(id: string): Promise<string> {
    const { rows } = await pool.query("SELECT status FROM orders WHERE id = $1", [id]);
    return rows[0].status;
  }
  const tickAt = (price: bigint, time = Date.now() + 1_000) => ({ symbol: "BTC", price, time });
  // Orders left open by earlier tests fill on the same ticks, so look only at this test's order.
  const only = <T extends { id: bigint }>(fills: T[], id: string) => fills.filter((o) => String(o.id) === id);

  test("a limit buy holds its cost at the limit, and cancelling gives it back", async () => {
    const t = await trader();
    const res = await order(t, limitBuy(coins(2n), usd(900n))); // 2 BTC at up to $900 = $1,800
    assert.equal(res.status, 201);
    const { order: placed } = await res.json();
    assert.deepEqual(
      { ...placed, id: undefined, createdAt: undefined },
      {
        id: undefined,
        createdAt: undefined,
        symbol: "BTC",
        side: "buy",
        type: "limit",
        status: "open",
        quantity: "200000000",
        quantityDecimals: 8,
        limitPrice: "90000000000",
        price: null,
        priceDecimals: 8,
        total: null,
        currency: "USD",
        closedAt: null,
      },
    );
    assert.deepEqual(await balances(t), { "cash USD": 1_000_000n - 180_000n, "hold USD": 180_000n });

    const cancelled = await cancel(t, placed.id);
    assert.equal(cancelled.status, 200);
    const body = (await cancelled.json()).order;
    assert.equal(body.status, "cancelled");
    assert.ok(body.closedAt);
    assert.deepEqual(await balances(t), { "cash USD": 1_000_000n, "hold USD": 0n });

    const again = await cancel(t, placed.id);
    assert.equal(again.status, 409);
    assert.equal((await again.json()).error, "order_not_open");
  });

  test("someone else's order, or one that doesn't exist, is a 404", async () => {
    const owner = await trader();
    const other = await trader();
    const { order: placed } = await (await order(owner, limitBuy(coins(1n), usd(900n)))).json();
    assert.equal((await cancel(other, placed.id)).status, 404);
    assert.equal((await cancel(owner, "999999999")).status, 404);
    assert.equal((await cancel(owner, "abc")).status, 404);
    assert.equal(await status(placed.id), "open");
  });

  test("held cash can't be spent twice, by another limit order or a market order", async () => {
    const t = await trader();
    // $10,000 of cash: a limit buy of 10 BTC at $1,000 holds all of it.
    assert.equal((await order(t, limitBuy(coins(10n), usd(1_000n)))).status, 201);
    const second = await order(t, limitBuy(1_000_000n, usd(900n))); // 0.01 BTC, $9
    assert.equal(second.status, 422);
    assert.deepEqual(await second.json(), { error: "insufficient_funds" });
    const market = await order(t, { symbol: "BTC", side: "buy", quantity: "1000000" });
    assert.deepEqual(await market.json(), { error: "insufficient_funds" });
  });

  test("a limit sell holds the coins, so they can't also be sold at market", async () => {
    const t = await trader();
    await order(t, { symbol: "BTC", side: "buy", quantity: String(coins(3n)) }); // $3,000
    const sell = await order(t, { symbol: "BTC", side: "sell", type: "limit", quantity: String(coins(2n)), limitPrice: String(usd(1_200n)) });
    assert.equal(sell.status, 201);
    assert.deepEqual(await balances(t), {
      "cash USD": 700_000n,
      "hold BTC": coins(2n),
      "holding BTC": coins(1n),
    });
    const tooMany = await order(t, { symbol: "BTC", side: "sell", quantity: String(coins(1n) + 1n) });
    assert.deepEqual(await tooMany.json(), { error: "insufficient_holdings" });
  });

  test("bad limit orders are refused before anything is held", async () => {
    const t = await trader();
    const missing = await order(t, { symbol: "BTC", side: "buy", type: "limit", quantity: "100000000" });
    assert.deepEqual(await missing.json(), { error: "invalid_limit_price" });
    const decimal = await order(t, { ...limitBuy(coins(1n), 0n), limitPrice: "900.5" });
    assert.deepEqual(await decimal.json(), { error: "invalid_limit_price" });
    const tiny = await order(t, limitBuy(100_000n, usd(900n))); // 0.001 BTC at $900 = $0.90
    assert.deepEqual(await tiny.json(), { error: "order_too_small" });
    const stop = await order(t, { ...limitBuy(coins(1n), usd(900n)), type: "stop" });
    assert.deepEqual(await stop.json(), { error: "unsupported_order_type" });
    assert.deepEqual(await balances(t), { "cash USD": 1_000_000n });
  });

  test("retrying a limit order with the same key places it once; a different limit price is a reused key", async () => {
    const t = await trader();
    const key = crypto.randomUUID();
    const first = await order(t, limitBuy(coins(1n), usd(900n)), key);
    const retry = await order(t, limitBuy(coins(1n), usd(900n)), key);
    assert.equal(retry.headers.get("idempotent-replayed"), "true");
    assert.equal((await retry.json()).order.id, (await first.json()).order.id);
    const changed = await order(t, limitBuy(coins(1n), usd(800n)), key);
    assert.deepEqual(await changed.json(), { error: "idempotency_key_reused" });
    assert.deepEqual(await balances(t), { "cash USD": 910_000n, "hold USD": 90_000n });
  });

  test("a tick at or below the limit fills a buy at the tick's price and returns what wasn't spent", async () => {
    const t = await trader();
    const { order: placed } = await (await order(t, limitBuy(coins(2n), usd(900n)))).json();

    assert.deepEqual(only(await matchTick(pool, tickAt(usd(901n))), placed.id), []);
    assert.equal(await status(placed.id), "open");

    const filled = only(await matchTick(pool, tickAt(usd(850n))), placed.id);
    assert.deepEqual(
      filled.map((o) => [String(o.id), o.status, o.price, o.total]),
      [[placed.id, "filled", usd(850n), 170_000n]],
    );
    // Held $1,800, spent $1,700, $100 back to cash.
    assert.deepEqual(await balances(t), {
      "cash USD": 1_000_000n - 170_000n,
      "hold USD": 0n,
      "holding BTC": coins(2n),
    });
    assert.deepEqual(only(await matchTick(pool, tickAt(usd(800n))), placed.id), [], "a filled order doesn't fill again");
    assert.equal((await cancel(t, placed.id)).status, 409);
  });

  test("a limit sell fills at the tick's price once it's at or above the limit", async () => {
    const t = await trader();
    await order(t, { symbol: "BTC", side: "buy", quantity: String(coins(1n)) });
    const body = { symbol: "BTC", side: "sell", type: "limit", quantity: String(coins(1n)), limitPrice: String(usd(1_200n)) };
    const { order: placed } = await (await order(t, body)).json();
    assert.deepEqual(only(await matchTick(pool, tickAt(usd(1_199n))), placed.id), []);
    const [filled] = only(await matchTick(pool, tickAt(usd(1_250n))), placed.id);
    assert.equal(String(filled!.id), placed.id);
    assert.deepEqual(await balances(t), { "cash USD": 1_000_000n + 25_000n, "hold BTC": 0n, "holding BTC": 0n });
  });

  test("a tick from before the order was placed doesn't fill it", async () => {
    const t = await trader();
    const { order: placed } = await (await order(t, limitBuy(coins(1n), usd(900n)))).json();
    assert.deepEqual(only(await matchTick(pool, tickAt(usd(800n), Date.now() - 60_000)), placed.id), []);
    assert.equal(await status(placed.id), "open");
  });

  test("a fill and a cancel racing for the same order: exactly one wins, and the money adds up", async () => {
    for (let round = 0; round < 15; round++) {
      const t = await trader();
      const { order: placed } = await (await order(t, limitBuy(coins(1n), usd(900n)))).json();
      const userId = (await pool.query("SELECT id FROM users WHERE email = $1", [t.email])).rows[0].id;
      const [fills, cancelled] = await Promise.all([
        matchTick(pool, tickAt(usd(900n))),
        withTransaction(pool, (client) => cancelOrder(client, userId, BigInt(placed.id))).catch((err) => err),
      ]);
      const filled = fills.some((o) => String(o.id) === placed.id);
      const wasCancelled = !(cancelled instanceof Error) && cancelled?.status === "cancelled";
      assert.equal(filled !== wasCancelled, true, `round ${round}: filled=${filled} cancelled=${wasCancelled}`);
      const b = await balances(t);
      assert.equal(b["hold USD"], 0n);
      if (filled) assert.equal(b["holding BTC"], coins(1n));
      else assert.equal(b["cash USD"], 1_000_000n);
      // A fill that lost the race skipped the locked order; the next tick finds it cancelled.
      assert.notEqual(await status(placed.id), "open");
    }
    assert.deepEqual(await withTransaction(pool, driftedAccounts), []);
  });

  test("the queue: a tick added by the price worker fills orders through the order worker", async () => {
    const t = await trader();
    const { order: placed } = await (await order(t, limitBuy(coins(1n), usd(900n)))).json();
    const connection = { url: REDIS_URL!, prefix: `test-bull-${randomBytes(6).toString("hex")}` };
    const queue = matchQueue(connection);
    const worker = startMatcher({ ...connection, pool, concurrency: 1 });
    try {
      const tick = tickAt(usd(890n));
      await enqueueTick(queue, tick);
      await enqueueTick(queue, tick); // the same tick twice is one job
      const deadline = Date.now() + 10_000;
      while ((await status(placed.id)) === "open" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(await status(placed.id), "filled");
      const counts = await queue.getJobCounts("completed", "failed", "waiting", "active");
      assert.deepEqual(counts, { completed: 1, failed: 0, waiting: 0, active: 0 });
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  test("the ledger still balances", async () => {
    assert.deepEqual(await withTransaction(pool, driftedAccounts), []);
  });
});
