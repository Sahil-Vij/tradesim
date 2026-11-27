import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Redis } from "ioredis";
import pg from "pg";
import { createApp } from "../src/app.ts";
import { parseKlines } from "../src/prices/candles.ts";
import { createTestRedis, skipWithoutRedis } from "./redis.ts";

// Two real 1m BTC klines from Binance, 26 Nov 2026.
const KLINES = [
  [1795681560000, "60673.40000000", "60692.18000000", "60663.67000000", "60682.88000000", "8.24582000", 1795681619999, "500332.69794990", 3049, "6.68723000", "405754.93823330", "0"],
  [1795681620000, "60682.89000000", "60699.99000000", "60680.02000000", "60680.03000000", "8.05291000", 1795681679999, "488689.77043600", 1724, "7.11771000", "431934.23523380", "0"],
];

test("parses Binance klines exactly, with times in seconds", () => {
  assert.deepEqual(parseKlines(KLINES)[0], {
    time: 1795681560,
    open: 6_067_340_000_000n,
    high: 6_069_218_000_000n,
    low: 6_066_367_000_000n,
    close: 6_068_288_000_000n,
    volume: 824_582_000n,
  });
  assert.throws(() => parseKlines({ code: -1121 }), /not an array/);
  assert.throws(() => parseKlines([["x"]]), /bad kline row/);
});

describe("GET /api/candles", { skip: skipWithoutRedis }, () => {
  let redis: Redis;
  let cleanup: () => Promise<void>;
  let app: Server;
  let binance: Server;
  let base: string;
  let requests: string[] = [];
  let respond: (res: import("node:http").ServerResponse) => void;
  const pool = new pg.Pool(); // never connected

  before(async () => {
    binance = createServer((req, res) => {
      requests.push(req.url ?? "");
      respond(res);
    }).listen(0);
    await new Promise((resolve) => binance.once("listening", resolve));
    ({ redis, cleanup } = createTestRedis());
    app = createApp({
      pool,
      redis,
      binanceRestUrl: `http://127.0.0.1:${(binance.address() as AddressInfo).port}`,
      jwtSecret: "j".repeat(32),
      secureCookies: false,
    }).listen(0);
    await new Promise((resolve) => app.once("listening", resolve));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  });
  after(async () => {
    await new Promise<void>((resolve) => app.close(() => resolve()));
    await new Promise<void>((resolve) => binance.close(() => resolve()));
    await Promise.all([cleanup(), pool.end()]);
  });
  // Each test asks for a different coin, so cached candles from one never answer another.
  beforeEach(() => {
    requests = [];
    respond = (res) => res.setHeader("content-type", "application/json").end(JSON.stringify(KLINES));
  });

  test("returns candles as strings in 10^-8 units, asking Binance for the USDT pair", async () => {
    const res = await fetch(`${base}/api/candles?symbol=BTC&interval=1m&limit=2`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.symbol, "BTC");
    assert.equal(body.priceDecimals, 8);
    assert.deepEqual(body.candles[1], {
      time: 1795681620,
      open: "6068289000000",
      high: "6069999000000",
      low: "6068002000000",
      close: "6068003000000",
      volume: "805291000",
    });
    assert.deepEqual(requests, ["/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=2"]);
  });

  test("serves repeat requests from the cache", async () => {
    const first = await (await fetch(`${base}/api/candles?symbol=ETH&interval=1h`)).json();
    const second = await (await fetch(`${base}/api/candles?symbol=ETH&interval=1h`)).json();
    assert.deepEqual(second, first);
    assert.equal(requests.length, 1);
    assert.match(requests[0]!, /limit=300$/); // the default
    const ttl = await redis.ttl("candles:ETH:1h:300");
    assert.ok(ttl > 0 && ttl <= 60, `ttl ${ttl}`);
  });

  test("validates symbol, interval and limit", async () => {
    const cases: Array<[string, string]> = [
      ["symbol=DOGEX", "unknown_symbol"],
      ["interval=1m", "unknown_symbol"],
      ["symbol=BTC&interval=2m", "invalid_interval"],
      ["symbol=BTC&interval=constructor", "invalid_interval"],
      ["symbol=BTC&limit=0", "invalid_limit"],
      ["symbol=BTC&limit=1001", "invalid_limit"],
      ["symbol=BTC&limit=2.5", "invalid_limit"],
    ];
    for (const [query, error] of cases) {
      const res = await fetch(`${base}/api/candles?${query}`);
      assert.equal(res.status, 400, query);
      assert.deepEqual(await res.json(), { error }, query);
    }
    assert.equal(requests.length, 0);
  });

  test("a Binance error is a 502 and isn't cached", async () => {
    respond = (res) => res.writeHead(451).end('{"code":0,"msg":"restricted location"}');
    const res = await fetch(`${base}/api/candles?symbol=SOL`);
    assert.equal(res.status, 502);
    assert.equal(res.headers.get("retry-after"), "5");
    assert.deepEqual(await res.json(), { error: "candles_unavailable" });

    respond = (res) => res.end(JSON.stringify(KLINES));
    assert.equal((await fetch(`${base}/api/candles?symbol=SOL`)).status, 200);
    assert.equal(requests.length, 2);
  });
});
