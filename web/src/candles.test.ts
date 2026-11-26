import { expect, test } from "vitest";
import { applyTick, precisionFor, toBar, type Bar } from "./candles.ts";

const bar: Bar = { time: 1_795_681_560, open: 100, high: 105, low: 98, close: 102, volume: 8 };
const at = (seconds: number) => seconds * 1000;

test("converts API candles in 10^-8 units to numbers for drawing", () => {
  expect(
    toBar({ time: 1, open: "6067340000000", high: "6069218000000", low: "5924000", close: "100000000", volume: "824582000" }),
  ).toEqual({ time: 1, open: 60_673.4, high: 60_692.18, low: 0.05924, close: 1, volume: 8.24582 });
});

test("a tick inside the newest candle moves its close and stretches high or low", () => {
  expect(applyTick(bar, 103, at(bar.time + 30), 60)).toEqual({ ...bar, close: 103 });
  expect(applyTick(bar, 107, at(bar.time + 59), 60)).toEqual({ ...bar, close: 107, high: 107 });
  expect(applyTick(bar, 95, at(bar.time + 1), 60)).toEqual({ ...bar, close: 95, low: 95 });
});

test("a tick in a later period opens a new candle at the previous close", () => {
  expect(applyTick(bar, 104, at(bar.time + 60), 60)).toEqual({
    time: bar.time + 60,
    open: 102,
    high: 104,
    low: 102,
    close: 104,
    volume: 0,
  });
  // After a gap, the new candle lands on its own period's start, not the next one in sequence.
  expect(applyTick(bar, 101, at(bar.time + 185), 60)?.time).toBe(bar.time + 180);
});

test("ignores ticks older than the newest candle, and does nothing with no candles", () => {
  expect(applyTick(bar, 50, at(bar.time - 1), 60)).toBeNull();
  expect(applyTick(undefined, 50, at(bar.time), 60)).toBeNull();
});

test("shows cents for coins over a dollar and five places under", () => {
  expect(precisionFor(60_673.4)).toBe(2);
  expect(precisionFor(0.05924)).toBe(5);
});
