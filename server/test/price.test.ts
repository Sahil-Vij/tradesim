import assert from "node:assert/strict";
import { test } from "node:test";
import { formatPrice, parseMiniTicker, parsePrice } from "../src/prices/price.ts";

test("parses Binance prices exactly into units of 10^-8", () => {
  assert.equal(parsePrice("63754.30000000"), 6_375_430_000_000n);
  assert.equal(parsePrice("0.05924000"), 5_924_000n);
  assert.equal(parsePrice("0.00000001"), 1n);
  assert.equal(parsePrice("42"), 4_200_000_000n);
  assert.equal(parsePrice("1.5"), 150_000_000n);
});

test("refuses anything that isn't a plain decimal with up to 8 places", () => {
  for (const bad of ["", "-1", "1e5", "1.", ".5", "0.123456789", "12,000", " 1", "NaN"]) {
    assert.throws(() => parsePrice(bad), /not a price/, bad);
  }
});

test("formats prices back without trailing zeros", () => {
  assert.equal(formatPrice(6_375_430_000_000n), "63754.3");
  assert.equal(formatPrice(5_924_000n), "0.05924");
  assert.equal(formatPrice(1n), "0.00000001");
  assert.equal(formatPrice(4_200_000_000n), "42");
  assert.equal(formatPrice(0n), "0");
});

const symbols = new Set(["BTC", "DOGE"]);
// Copied from a real message, 19 Nov 2026.
const btc = `{"stream":"btcusdt@miniTicker","data":{"e":"24hrMiniTicker","E":1795091687017,"s":"BTCUSDT","c":"63754.30000000","o":"64198.59000000","h":"64228.72000000","l":"62062.97000000","v":"19896.24450000","q":"1257133849.29628780"}}`;

test("reads a mini ticker from the combined stream", () => {
  assert.deepEqual(parseMiniTicker(btc, symbols), { symbol: "BTC", price: 6_375_430_000_000n, time: 1795091687017 });
});

test("ignores messages that aren't ticks we asked for", () => {
  const ticker = (data: object) => JSON.stringify({ stream: "x", data });
  const base = { e: "24hrMiniTicker", E: 1, c: "1.0" };
  assert.equal(parseMiniTicker("not json", symbols), null);
  assert.equal(parseMiniTicker("null", symbols), null);
  assert.equal(parseMiniTicker(`{"result":null,"id":1}`, symbols), null);
  assert.equal(parseMiniTicker(ticker({ ...base, s: "ETHUSDT" }), symbols), null);
  assert.equal(parseMiniTicker(ticker({ ...base, s: "BTCEUR" }), symbols), null);
  assert.equal(parseMiniTicker(ticker({ ...base, s: "BTCUSDT", e: "trade" }), symbols), null);
  assert.equal(parseMiniTicker(ticker({ ...base, s: "BTCUSDT", c: 1 }), symbols), null);
  assert.equal(parseMiniTicker(ticker({ ...base, s: "BTCUSDT", c: "0.00000000" }), symbols), null);
});
