// The API sends every amount as a string of whole smallest units plus a number of decimals
// (cents with 2, coins and prices with 8). These helpers never turn an amount into a float.

/** "6375430000000", 8 → "63754.3"; trailing zeros dropped, at least `minFraction` kept. */
export function formatUnits(units: string | bigint, decimals: number, minFraction = 0): string {
  const value = BigInt(units);
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  let fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  fraction = fraction.padEnd(minFraction, "0");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${fraction ? `.${fraction}` : ""}`;
}

/** Indian grouping for rupees: 10,00,000. */
export function formatInr(paise: string | bigint): string {
  const value = BigInt(paise);
  const rupees = (value / 100n).toString();
  const cents = (value % 100n).toString().padStart(2, "0");
  const last3 = rupees.slice(-3);
  const rest = rupees.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `₹${rest ? `${rest},` : ""}${last3}.${cents}`;
}

export function formatUsd(cents: string | bigint): string {
  return `$${formatUnits(cents, 2, 2)}`;
}

/** A price in 10^-8 dollars, with enough places for a coin worth a few cents. */
export function formatPrice(units: string | bigint): string {
  const value = BigInt(units);
  // Under $1, show up to 5 places (DOGE $0.05674); otherwise cents.
  if (value < 100_000_000n) return `$${formatUnits((value / 1000n) * 1000n, 8)}`;
  return `$${formatUnits(value / 1_000_000n, 2, 2)}`;
}

/** Parses what a person typed ("0.05", "12") into whole units. Null if it isn't a plain amount. */
export function parseAmount(text: string, decimals: number): bigint | null {
  const match = /^(\d*)(?:\.(\d*))?$/.exec(text.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const [, whole = "", fraction = ""] = match;
  if (fraction.length > decimals) return null;
  return BigInt((whole || "0") + fraction.padEnd(decimals, "0"));
}

/** Same rule as the server: quantity × price / 10^14 in cents, rounded half up. */
export function orderTotal(quantity: bigint, price: bigint): bigint {
  const scale = 10n ** 14n;
  return (quantity * price + scale / 2n) / scale;
}

/** The most coins `cents` can buy at `price`, never costing more than `cents` after rounding. */
export function maxQuantity(cents: bigint, price: bigint): bigint {
  return (cents * 10n ** 14n) / price;
}
