import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import { createApp } from "../src/app.ts";
import { latestTicks, PRICES_KEY, saveTick, TICKS_CHANNEL } from "../src/prices/store.ts";
import { createTestRedis, REDIS_URL, skipWithoutRedis } from "./redis.ts";
import { Redis as RedisClient, type Redis } from "ioredis";

describe("price store and GET /api/prices", { skip: skipWithoutRedis }, () => {
  let redis: Redis;
  let cleanup: () => Promise<void>;
  let server: Server;
  let base: string;
  let clock = 0;
  const pool = new pg.Pool(); // never connected

  before(async () => {
    ({ redis, cleanup } = createTestRedis());
    server = createApp({ pool, redis, now: () => clock, jwtSecret: "j".repeat(32), secureCookies: false }).listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all([cleanup(), pool.end()]);
  });

  test("is empty before the worker has written anything", async () => {
    const res = await fetch(`${base}/api/prices`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { prices: [] });
  });

  test("keeps the latest tick per symbol and drops ones that arrive late", async () => {
    assert.equal(await saveTick(redis, { symbol: "BTC", price: 100n, time: 2_000 }), true);
    assert.equal(await saveTick(redis, { symbol: "BTC", price: 90n, time: 1_000 }), false); // older
    assert.equal(await saveTick(redis, { symbol: "BTC", price: 95n, time: 2_000 }), false); // same time
    assert.equal(await saveTick(redis, { symbol: "DOGE", price: 5_924_000n, time: 1_500 }), true);
    assert.equal(await saveTick(redis, { symbol: "BTC", price: 110n, time: 3_000 }), true);
    assert.deepEqual(await latestTicks(redis), [
      { symbol: "BTC", price: 110n, time: 3_000 },
      { symbol: "DOGE", price: 5_924_000n, time: 1_500 },
    ]);
  });

  test("publishes each saved tick, and only saved ones", async () => {
    const sub = new RedisClient(REDIS_URL!);
    await sub.subscribe(TICKS_CHANNEL);
    const messages: string[] = [];
    sub.on("message", (_ch, m) => messages.push(m));

    await saveTick(redis, { symbol: "ETH", price: 300_000_000_000n, time: 5_000 });
    await saveTick(redis, { symbol: "ETH", price: 1n, time: 4_000 }); // late, not published
    await new Promise((resolve) => setTimeout(resolve, 50));
    await sub.quit();

    assert.deepEqual(messages.map((m) => JSON.parse(m)), [{ symbol: "ETH", price: "300000000000", time: 5_000 }]);
  });

  test("returns prices as strings with their age, flagging stale ones", async () => {
    await saveTick(redis, { symbol: "ETH", price: 300_000_000_000n, time: 5_000 + 1 });
    clock = 15_001; // BTC is 12s old, DOGE 13.5s, ETH exactly 10s
    const res = await fetch(`${base}/api/prices`);
    const body = (await res.json()) as { prices: Array<Record<string, unknown>> };
    assert.deepEqual(
      body.prices.map(({ symbol, price, ageMs, stale }) => ({ symbol, price, ageMs, stale })),
      [
        { symbol: "BTC", price: "110", ageMs: 12_001, stale: true },
        { symbol: "DOGE", price: "5924000", ageMs: 13_501, stale: true },
        { symbol: "ETH", price: "300000000000", ageMs: 10_000, stale: false },
      ],
    );
    assert.deepEqual(body.prices[0], {
      symbol: "BTC",
      quote: "USD",
      price: "110",
      decimals: 8,
      time: "1970-01-01T00:00:03.000Z",
      ageMs: 12_001,
      stale: true,
    });
  });

  test("a tick stamped ahead of our clock has age zero, not negative", async () => {
    clock = 0;
    const res = await fetch(`${base}/api/prices`);
    const body = (await res.json()) as { prices: Array<{ ageMs: number }> };
    assert.ok(body.prices.every((p) => p.ageMs === 0));
    assert.ok(await redis.exists(PRICES_KEY));
  });
});
