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
import { cancelOrder, crosses, matchTick } from "../src/orders/pending.ts";
import { enqueueTick, matchQueue, startMatcher } from "../src/orders/matcher.ts";
import { saveTick } from "../src/prices/store.ts";
import { createTestPool, skipWithoutDb } from "./db.ts";
import { createTestRedis, REDIS_URL, skipWithoutRedis } from "./redis.ts";

const usd = (dollars: bigint) => dollars * 100_000_000n; // a price of $d in 10^-8 units
const coins = (n: bigint) => n * 100_000_000n;

test("a limit buy crosses at or below its limit, a limit sell at or above", () => {
  const limitPrice = usd(900n);
  const limit = (side: string) => ({ type: "limit", side, limitPrice, stopPrice: null });
  assert.equal(crosses(limit("buy"), usd(900n)), true);
  assert.equal(crosses(limit("buy"), usd(899n)), true);
  assert.equal(crosses(limit("buy"), usd(901n)), false);
  assert.equal(crosses(limit("sell"), usd(900n)), true);
  assert.equal(crosses(limit("sell"), usd(899n)), false);
  assert.equal(crosses({ ...limit("buy"), limitPrice: null }, usd(1n)), false);
});

test("a stop sell triggers once the price is at or below its stop", () => {
  const stop = { type: "stop", side: "sell", limitPrice: null, stopPrice: usd(800n) };
  assert.equal(crosses(stop, usd(801n)), false);
  assert.equal(crosses(stop, usd(800n)), true);
  assert.equal(crosses(stop, usd(500n)), true);
  assert.equal(crosses({ ...stop, side: "buy" }, usd(500n)), false);
});

const skip = skipWithoutDb || skipWithoutRedis;

describe("limit and stop orders", { skip }, () => {
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
    const trailing = await order(t, { ...limitBuy(coins(1n), usd(900n)), type: "trailing_stop" });
    assert.deepEqual(await trailing.json(), { error: "unsupported_order_type" });
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
      // The order fills partway through the job, which goes on to match other tests' orders, so
      // wait for the job to finish rather than for the order to change.
      const deadline = Date.now() + 10_000;
      for (;;) {
        const { completed = 0, failed = 0 } = await queue.getJobCounts("completed", "failed");
        if (completed + failed > 0 || Date.now() > deadline) break;
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

  const stopSell = (quantity: bigint, stop: bigint) => ({
    symbol: "BTC",
    side: "sell",
    type: "stop",
    quantity: String(quantity),
    stopPrice: String(stop),
  });

  test("a stop-loss holds the coins and sells at the tick's price once the price falls to the stop", async () => {
    const t = await trader();
    await order(t, { symbol: "BTC", side: "buy", quantity: String(coins(2n)) }); // $2,000 at $1,000
    const res = await order(t, stopSell(coins(2n), usd(800n)));
    assert.equal(res.status, 201);
    const { order: placed } = await res.json();
    assert.equal(placed.type, "stop");
    assert.equal(placed.status, "open");
    assert.equal(placed.stopPrice, String(usd(800n)));
    assert.equal(placed.limitPrice, undefined);
    assert.deepEqual(await balances(t), { "cash USD": 800_000n, "hold BTC": coins(2n), "holding BTC": 0n });

    // A rise, or a fall that stays above the stop, does nothing.
    assert.deepEqual(only(await matchTick(pool, tickAt(usd(1_100n))), placed.id), []);
    assert.deepEqual(only(await matchTick(pool, tickAt(usd(801n))), placed.id), []);

    // The price gaps past the stop: the sell happens at $760, not $800.
    const [filled] = only(await matchTick(pool, tickAt(usd(760n))), placed.id);
    assert.equal(filled!.status, "filled");
    assert.equal(filled!.price, usd(760n));
    assert.equal(filled!.total, 152_000n);
    assert.deepEqual(await balances(t), { "cash USD": 800_000n + 152_000n, "hold BTC": 0n, "holding BTC": 0n });
  });

  test("a stop-loss fires on a tick exactly at its stop", async () => {
    const t = await trader();
    await order(t, { symbol: "BTC", side: "buy", quantity: String(coins(1n)) });
    const { order: placed } = await (await order(t, stopSell(coins(1n), usd(800n)))).json();
    const [filled] = only(await matchTick(pool, tickAt(usd(800n))), placed.id);
    assert.equal(filled!.total, 80_000n);
  });

  test("a stop-loss and a limit sell can't both hold the same coins, and cancelling a stop gives them back", async () => {
    const t = await trader();
    await order(t, { symbol: "BTC", side: "buy", quantity: String(coins(1n)) });
    const { order: stop } = await (await order(t, stopSell(coins(1n), usd(800n)))).json();
    const takeProfit = await order(t, { ...limitBuy(coins(1n), usd(1_200n)), side: "sell" });
    assert.deepEqual(await takeProfit.json(), { error: "insufficient_holdings" });

    const cancelled = await cancel(t, stop.id);
    assert.equal((await cancelled.json()).order.status, "cancelled");
    assert.deepEqual(await balances(t), { "cash USD": 900_000n, "hold BTC": 0n, "holding BTC": coins(1n) });
    assert.deepEqual(only(await matchTick(pool, tickAt(usd(700n))), stop.id), [], "a cancelled stop never fires");
  });

  test("bad stop orders are refused before anything is held", async () => {
    const t = await trader();
    await order(t, { symbol: "BTC", side: "buy", quantity: String(coins(1n)) });
    const buy = await order(t, { ...stopSell(coins(1n), usd(1_100n)), side: "buy" });
    assert.equal(buy.status, 400);
    assert.deepEqual(await buy.json(), { error: "stop_orders_are_sells" });
    const missing = await order(t, { symbol: "BTC", side: "sell", type: "stop", quantity: String(coins(1n)) });
    assert.deepEqual(await missing.json(), { error: "invalid_stop_price" });
    const zero = await order(t, stopSell(coins(1n), 0n));
    assert.deepEqual(await zero.json(), { error: "invalid_stop_price" });
    const tiny = await order(t, stopSell(100_000n, usd(800n))); // 0.001 BTC at $800 = $0.80
    assert.deepEqual(await tiny.json(), { error: "order_too_small" });
    const notHeld = await order(t, stopSell(coins(2n), usd(800n)));
    assert.deepEqual(await notHeld.json(), { error: "insufficient_holdings" });
    assert.deepEqual(await balances(t), { "cash USD": 900_000n, "holding BTC": coins(1n) });
  });

  test("a stop's idempotency key is tied to its stop price", async () => {
    const t = await trader();
    await order(t, { symbol: "BTC", side: "buy", quantity: String(coins(1n)) });
    const key = crypto.randomUUID();
    const first = await order(t, stopSell(coins(1n), usd(800n)), key);
    const retry = await order(t, stopSell(coins(1n), usd(800n)), key);
    assert.equal((await retry.json()).order.id, (await first.json()).order.id);
    const moved = await order(t, stopSell(coins(1n), usd(750n)), key);
    assert.deepEqual(await moved.json(), { error: "idempotency_key_reused" });
  });

  // Buy 1 BTC at up to $1,000; sell at $1,200 (take profit) or once it falls to $800 (stop loss).
  const bracket = (overrides: object = {}) => ({
    symbol: "BTC",
    side: "buy",
    type: "bracket",
    quantity: String(coins(1n)),
    limitPrice: String(usd(1_000n)),
    takeProfitPrice: String(usd(1_200n)),
    stopLossPrice: String(usd(800n)),
    ...overrides,
  });
  async function children(parentId: string) {
    const { rows } = await pool.query(
      "SELECT id, type, status, limit_price, stop_price, release_entry_id FROM orders WHERE parent_id = $1 ORDER BY id",
      [parentId],
    );
    return rows;
  }
  /** Places a bracket and fills it at `price` with a tick a second from now. Returns it and the next tick's time. */
  async function filledBracket(t: Trader, price = usd(950n)) {
    const { order: placed } = await (await order(t, bracket())).json();
    const time = Date.now() + 1_000;
    const fills = only(await matchTick(pool, tickAt(price, time)), placed.id);
    assert.equal(fills.length, 1);
    return { placed, next: time + 1_000 };
  }

  test("a bracket waits like a limit buy, holding its cost, and can be cancelled before it fills", async () => {
    const t = await trader();
    const res = await order(t, bracket());
    assert.equal(res.status, 201);
    const { order: placed } = await res.json();
    assert.equal(placed.type, "bracket");
    assert.equal(placed.status, "open");
    assert.equal(placed.limitPrice, String(usd(1_000n)));
    assert.equal(placed.takeProfitPrice, String(usd(1_200n)));
    assert.equal(placed.stopLossPrice, String(usd(800n)));
    assert.equal(placed.parentId, undefined);
    assert.deepEqual(await balances(t), { "cash USD": 900_000n, "hold USD": 100_000n });

    // Above the limit nothing happens, however far it moves.
    assert.deepEqual(only(await matchTick(pool, tickAt(usd(1_300n))), placed.id), []);
    assert.equal((await cancel(t, placed.id)).status, 200);
    assert.deepEqual(await balances(t), { "cash USD": 1_000_000n, "hold USD": 0n });
    assert.deepEqual(await children(placed.id), []);
  });

  test("when a bracket fills, its coins go on hold for a take-profit and a stop-loss sell", async () => {
    const t = await trader();
    const { placed } = await filledBracket(t, usd(950n));
    // Held $1,000, spent $950, $50 back. The coin is on hold, not free to sell.
    assert.deepEqual(await balances(t), { "cash USD": 905_000n, "hold BTC": coins(1n), "hold USD": 0n, "holding BTC": 0n });
    const kids = await children(placed.id);
    assert.deepEqual(
      kids.map((k) => [k.type, k.status, k.limit_price, k.stop_price]),
      [
        ["limit", "open", usd(1_200n), null],
        ["stop", "open", null, usd(800n)],
      ],
    );
    const market = await order(t, { symbol: "BTC", side: "sell", quantity: "1000000" });
    assert.deepEqual(await market.json(), { error: "insufficient_holdings" });
    assert.equal((await cancel(t, placed.id)).status, 409, "the bracket itself is filled; cancel a child instead");
  });

  test("the take profit filling cancels the stop loss, in the same entry", async () => {
    const t = await trader();
    const { placed, next } = await filledBracket(t);
    const [target, stop] = await children(placed.id);
    const fills = only(await matchTick(pool, tickAt(usd(1_250n), next)), String(target.id));
    assert.equal(fills[0]!.price, usd(1_250n));
    assert.equal(fills[0]!.parentId, BigInt(placed.id));

    const [after1, after2] = await children(placed.id);
    assert.equal(after1.status, "filled");
    assert.equal(after2.status, "cancelled");
    const { rows } = await pool.query("SELECT entry_id FROM orders WHERE id = $1", [target.id]);
    assert.equal(after2.release_entry_id, rows[0].entry_id);
    // Bought for $950, sold for $1,250.
    assert.deepEqual(await balances(t), { "cash USD": 1_030_000n, "hold BTC": 0n, "hold USD": 0n, "holding BTC": 0n });
    assert.deepEqual(only(await matchTick(pool, tickAt(usd(700n), next + 1_000)), String(stop.id)), []);
  });

  test("the stop loss filling cancels the take profit; the tick that filled the bracket can't fire it", async () => {
    const t = await trader();
    // The price gaps straight through the stop: the bracket buys at $790, below its $800 stop.
    const { placed, next } = await filledBracket(t, usd(790n));
    assert.deepEqual(
      (await children(placed.id)).map((k) => k.status),
      ["open", "open"],
    );
    const [target, stop] = await children(placed.id);
    const [filled] = only(await matchTick(pool, tickAt(usd(790n), next)), String(stop.id));
    assert.equal(filled!.status, "filled");
    assert.equal((await children(placed.id))[0].status, "cancelled");
    assert.equal((await cancel(t, String(target.id))).status, 409);
    assert.deepEqual(await balances(t), { "cash USD": 1_000_000n, "hold BTC": 0n, "hold USD": 0n, "holding BTC": 0n });
  });

  test("cancelling either child cancels both and gives the coins back once", async () => {
    const t = await trader();
    const { placed } = await filledBracket(t);
    const [target] = await children(placed.id);
    const res = await cancel(t, String(target.id));
    assert.equal(res.status, 200);
    const body = (await res.json()).order;
    assert.equal(body.status, "cancelled");
    assert.equal(body.parentId, placed.id);
    const kids = await children(placed.id);
    assert.deepEqual(kids.map((k) => k.status), ["cancelled", "cancelled"]);
    assert.equal(kids[0].release_entry_id, kids[1].release_entry_id);
    assert.deepEqual(await balances(t), { "cash USD": 905_000n, "hold BTC": 0n, "hold USD": 0n, "holding BTC": coins(1n) });
  });

  test("two ticks racing for the two children: exactly one fills", async () => {
    for (let round = 0; round < 15; round++) {
      const t = await trader();
      const { placed, next } = await filledBracket(t);
      // One worker sees the price spike to the target while another sees it drop to the stop.
      await Promise.all([matchTick(pool, tickAt(usd(1_300n), next)), matchTick(pool, tickAt(usd(700n), next))]);
      const statuses = (await children(placed.id)).map((k) => k.status).sort();
      // A tick that lost the race skips the locked order, so neither may have filled yet; the next tick decides.
      if (!statuses.includes("filled")) {
        assert.deepEqual(statuses, ["open", "open"], `round ${round}`);
        await matchTick(pool, tickAt(usd(1_300n), next + 1_000));
      }
      assert.deepEqual((await children(placed.id)).map((k) => k.status).sort(), ["cancelled", "filled"], `round ${round}`);
      const b = await balances(t);
      assert.equal(b["hold BTC"], 0n);
      assert.ok(b["cash USD"] === 905_000n + 130_000n || b["cash USD"] === 905_000n + 70_000n, `round ${round}`);
    }
    assert.deepEqual(await withTransaction(pool, driftedAccounts), []);
  });

  test("bad brackets are refused before anything is held", async () => {
    const t = await trader();
    const cases: Array<[object, string]> = [
      [{ side: "sell" }, "bracket_orders_are_buys"],
      [{ takeProfitPrice: undefined }, "invalid_take_profit_price"],
      [{ stopLossPrice: "8.5" }, "invalid_stop_loss_price"],
      [{ limitPrice: undefined }, "invalid_limit_price"],
      [{ takeProfitPrice: String(usd(1_000n)) }, "invalid_bracket_prices"],
      [{ stopLossPrice: String(usd(1_100n)) }, "invalid_bracket_prices"],
    ];
    for (const [overrides, error] of cases) {
      const res = await order(t, bracket(overrides));
      assert.equal(res.status, 400, error);
      assert.deepEqual(await res.json(), { error });
    }
    const tiny = await order(t, bracket({ quantity: "50000" })); // 0.0005 BTC at $1,000 = $0.50
    assert.deepEqual(await tiny.json(), { error: "order_too_small" });
    assert.deepEqual(await balances(t), { "cash USD": 1_000_000n });
  });

  test("a bracket's idempotency key covers its take profit and stop loss", async () => {
    const t = await trader();
    const key = crypto.randomUUID();
    const first = await (await order(t, bracket(), key)).json();
    const retry = await order(t, bracket(), key);
    assert.equal((await retry.json()).order.id, first.order.id);
    const moved = await order(t, bracket({ stopLossPrice: String(usd(750n)) }), key);
    assert.deepEqual(await moved.json(), { error: "idempotency_key_reused" });
  });

  test("the ledger still balances", async () => {
    assert.deepEqual(await withTransaction(pool, driftedAccounts), []);
  });
});
