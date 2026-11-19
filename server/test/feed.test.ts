import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { backoffDelay, startBinanceFeed, type Feed } from "../src/prices/feed.ts";
import type { Tick } from "../src/prices/price.ts";

// A stand-in for Binance: a local WebSocket server the test drives by hand.
let server: WebSocketServer;
let url: string;
const connections: Array<{ socket: WebSocket; path: string }> = [];
let onConnection: ((socket: WebSocket) => void) | null = null;

before(async () => {
  server = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  server.on("connection", (socket, req) => {
    connections.push({ socket, path: req.url ?? "" });
    onConnection?.(socket);
  });
});

after(async () => {
  for (const client of server.clients) client.terminate();
  await new Promise((resolve) => server.close(resolve));
});

const ticker = (symbol: string, price: string, time: number) =>
  JSON.stringify({ stream: `${symbol.toLowerCase()}usdt@miniTicker`, data: { e: "24hrMiniTicker", E: time, s: `${symbol}USDT`, c: price } });

function nextConnection(): Promise<WebSocket> {
  return new Promise((resolve) => {
    onConnection = (socket) => {
      onConnection = null;
      resolve(socket);
    };
  });
}

function collect(feedOptions: Partial<Parameters<typeof startBinanceFeed>[0]> = {}) {
  const ticks: Tick[] = [];
  const logs: string[] = [];
  let waiter: (() => void) | null = null;
  const feed: Feed = startBinanceFeed({
    symbols: ["BTC", "DOGE"],
    url,
    minDelayMs: 10,
    maxDelayMs: 40,
    log: (m) => logs.push(m),
    onTick: (t) => {
      ticks.push(t);
      waiter?.();
    },
    ...feedOptions,
  });
  const waitForTicks = (n: number) =>
    new Promise<void>((resolve) => {
      if (ticks.length >= n) return resolve();
      waiter = () => ticks.length >= n && resolve();
    });
  return { feed, ticks, logs, waitForTicks };
}

test("subscribes to every symbol on one combined stream and passes ticks on", async () => {
  const connected = nextConnection();
  const { feed, ticks, waitForTicks } = collect();
  const socket = await connected;
  assert.equal(connections.at(-1)!.path, "/stream?streams=btcusdt@miniTicker/dogeusdt@miniTicker");

  socket.send(ticker("BTC", "63754.30000000", 1000));
  socket.send(ticker("ETH", "3000.00000000", 1001)); // not subscribed: ignored
  socket.send("garbage");
  socket.send(ticker("DOGE", "0.05924000", 1002));
  await waitForTicks(2);
  feed.stop();

  assert.deepEqual(ticks, [
    { symbol: "BTC", price: 6_375_430_000_000n, time: 1000 },
    { symbol: "DOGE", price: 5_924_000n, time: 1002 },
  ]);
});

test("reconnects after the server drops the connection", async () => {
  let connected = nextConnection();
  const { feed, ticks, logs, waitForTicks } = collect();
  let socket = await connected;
  socket.send(ticker("BTC", "1.00000000", 1));
  await waitForTicks(1);

  connected = nextConnection();
  socket.close(1001, "going away"); // what Binance does at the 24-hour mark
  socket = await connected;
  socket.send(ticker("BTC", "2.00000000", 2));
  await waitForTicks(2);
  feed.stop();

  assert.deepEqual(
    ticks.map((t) => t.price),
    [100_000_000n, 200_000_000n],
  );
  assert.ok(logs.some((l) => l.startsWith("price feed: disconnected, retrying in")));
});

test("replaces a connection that goes quiet", async () => {
  let connected = nextConnection();
  const { feed, logs } = collect({ silenceMs: 50 });
  await connected;
  // The server keeps the socket open but sends nothing. The feed should give up on it and dial again.
  connected = nextConnection();
  await connected;
  feed.stop();
  assert.ok(logs.includes("price feed: no data for 50ms, reconnecting"));
});

test("a bad price in one message doesn't stop the feed", async () => {
  const connected = nextConnection();
  const { feed, ticks, logs, waitForTicks } = collect();
  const socket = await connected;
  socket.send(ticker("BTC", "1e5", 1));
  socket.send(ticker("BTC", "5.00000000", 2));
  await waitForTicks(1);
  feed.stop();
  assert.deepEqual(ticks.map((t) => t.price), [500_000_000n]);
  assert.ok(logs.some((l) => l.includes('not a price: "1e5"')));
});

test("stop() closes the socket and never reconnects", async () => {
  const connected = nextConnection();
  const { feed } = collect();
  const socket = await connected;
  const before = connections.length;
  const closed = new Promise((resolve) => socket.once("close", resolve));
  feed.stop();
  await closed;
  await new Promise((resolve) => setTimeout(resolve, 100)); // longer than any retry delay
  assert.equal(connections.length, before);
});

test("backoff doubles up to the cap, with jitter between the minimum and the cap", () => {
  const top = () => 1; // the most jitter allows
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6].map((n) => backoffDelay(n, 1_000, 30_000, top)),
    [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000],
  );
  assert.equal(backoffDelay(5, 1_000, 30_000, () => 0), 1_000);
  assert.equal(backoffDelay(3, 1_000, 30_000, () => 0.5), 4_500);
});
