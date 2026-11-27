import { expect, test } from "vitest";
import { formatInr, formatPrice, formatUnits, formatUsd, maxQuantity, orderTotal, parseAmount } from "./money.ts";

test("formats whole units without floats", () => {
  expect(formatUnits("6375430000000", 8)).toBe("63,754.3");
  expect(formatUnits("5000000", 8)).toBe("0.05");
  expect(formatUnits("1", 8)).toBe("0.00000001");
  expect(formatUnits("123456789012345678", 8)).toBe("1,234,567,890.12345678");
  expect(formatUsd("696189")).toBe("$6,961.89");
  expect(formatUsd("100")).toBe("$1.00");
  expect(formatUsd("0")).toBe("$0.00");
});

test("formats rupees with Indian grouping", () => {
  expect(formatInr("100000000")).toBe("₹10,00,000.00");
  expect(formatInr("1234567899")).toBe("₹1,23,45,678.99");
  expect(formatInr("99")).toBe("₹0.99");
});

test("shows cents for big prices and more places for coins under a dollar", () => {
  expect(formatPrice("6069563000000")).toBe("$60,695.63");
  expect(formatPrice("5676000")).toBe("$0.05676");
  expect(formatPrice("95670000")).toBe("$0.9567");
});

test("parses what people type, and refuses what it can't represent", () => {
  expect(parseAmount("0.05", 8)).toBe(5_000_000n);
  expect(parseAmount("12", 8)).toBe(1_200_000_000n);
  expect(parseAmount(".5", 8)).toBe(50_000_000n);
  expect(parseAmount(" 1. ", 8)).toBe(100_000_000n);
  for (const bad of ["", ".", "abc", "1e5", "-1", "1,000", "0.000000001"]) {
    expect(parseAmount(bad, 8), bad).toBeNull();
  }
});

test("estimates the total the same way the server charges it", () => {
  expect(orderTotal(5_000_000n, 6_076_221_000_000n)).toBe(303_811n); // 0.05 BTC, the live test from #21
  expect(orderTotal(100_000_000n, 1_500_000n)).toBe(2n); // 1.5¢ rounds up
});

test("Max never costs more than the cash available", () => {
  for (const [cash, price] of [
    [696_189n, 5_676_000n],
    [1_000_000n, 6_069_563_000_000n],
    [1n, 95_670_000n],
  ] as const) {
    const q = maxQuantity(cash, price);
    expect(orderTotal(q, price) <= cash).toBe(true);
    expect(orderTotal(q + 1n, price) <= cash + 1n).toBe(true);
  }
});
