import type pg from "pg";
import { accountFor, postEntry, type Line } from "../ledger.ts";
import { STARTER_SYMBOLS } from "../prices/price.ts";

// See docs/design.md, "Money" and "Orders".

export const TRADABLE = new Set<string>(STARTER_SYMBOLS);
/** Crypto trades against the USD wallet. */
export const QUOTE_CURRENCY = "USD";
/**
 * Smallest order, in cents. Without it, 0.00000001 BTC at $60,000 costs 0.06¢, which rounds to
 * nothing, and the coins would be free.
 */
export const MIN_ORDER_TOTAL = 100n;

export type Side = "buy" | "sell";
export type MarketOrder = { symbol: string; side: Side; quantity: bigint };

/** An order as stored. price and total are set once it fills; limitPrice only on a limit order. */
export type Order = MarketOrder & {
  id: bigint;
  type: "market" | "limit";
  status: "open" | "filled" | "cancelled";
  limitPrice: bigint | null;
  price: bigint | null;
  total: bigint | null;
  currency: string;
  createdAt: Date;
  closedAt: Date | null;
};

type OrderRow = {
  id: bigint;
  symbol: string;
  side: Side;
  type: Order["type"];
  status: Order["status"];
  quantity: bigint;
  limit_price: bigint | null;
  price: bigint | null;
  total: bigint | null;
  currency: string;
  created_at: Date;
  closed_at: Date | null;
};

export const ORDER_COLUMNS =
  "id, symbol, side, type, status, quantity, limit_price, price, total, currency, created_at, closed_at";

export function toOrder(row: OrderRow): Order {
  return {
    id: row.id,
    symbol: row.symbol,
    side: row.side,
    type: row.type,
    status: row.status,
    quantity: row.quantity,
    limitPrice: row.limit_price,
    price: row.price,
    total: row.total,
    currency: row.currency,
    createdAt: row.created_at,
    closedAt: row.closed_at,
  };
}

/**
 * What `quantity` (10^-8 of a coin) costs at `price` (10^-8 of a dollar per coin), in cents,
 * rounded half up: quantity × price / 10^14.
 */
export function orderTotal(quantity: bigint, price: bigint): bigint {
  const scale = 10n ** 14n;
  return (quantity * price + scale / 2n) / scale;
}

export class OrderTooSmallError extends Error {}

/** The four accounts a trade in `symbol` touches. */
export async function tradeAccounts(client: pg.ClientBase, userId: bigint, symbol: string) {
  return {
    userCash: await accountFor(client, userId, "cash", QUOTE_CURRENCY),
    houseCash: await accountFor(client, null, "house", QUOTE_CURRENCY),
    userCoin: await accountFor(client, userId, "holding", symbol),
    houseCoin: await accountFor(client, null, "house", symbol),
  };
}

/**
 * Fills a market order at `price` as one journal entry: cash one way, coins the other, with the
 * house on the other side. Must run in a transaction. Throws InsufficientFundsError (from the
 * ledger) when the user can't pay, or for a sell, doesn't hold enough of the coin.
 */
export async function fillMarketOrder(
  client: pg.ClientBase,
  userId: bigint,
  order: MarketOrder,
  price: bigint,
): Promise<Order> {
  const total = orderTotal(order.quantity, price);
  if (total < MIN_ORDER_TOTAL) throw new OrderTooSmallError();

  const { userCash, houseCash, userCoin, houseCoin } = await tradeAccounts(client, userId, order.symbol);

  // Positive amounts flow to the user on a buy; a sell is the same entry reversed.
  const sign = order.side === "buy" ? 1n : -1n;
  const lines: Line[] = [
    { accountId: userCash, amount: -sign * total },
    { accountId: houseCash, amount: sign * total },
    { accountId: userCoin, amount: sign * order.quantity },
    { accountId: houseCoin, amount: -sign * order.quantity },
  ];
  const entryId = await postEntry(client, {
    kind: "trade",
    description: `Market ${order.side} ${order.symbol}`,
    lines,
  });

  const { rows } = await client.query<OrderRow>(
    `INSERT INTO orders (user_id, symbol, side, type, status, quantity, price, total, currency, entry_id)
     VALUES ($1, $2, $3, 'market', 'filled', $4, $5, $6, $7, $8)
     RETURNING ${ORDER_COLUMNS}`,
    [userId, order.symbol, order.side, order.quantity, price, total, QUOTE_CURRENCY, entryId],
  );
  return toOrder(rows[0]!);
}
