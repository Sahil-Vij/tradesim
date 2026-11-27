import type pg from "pg";
import { accountFor, postEntry, withTransaction, type Line } from "../ledger.ts";
import type { Tick } from "../prices/price.ts";
import {
  MIN_ORDER_TOTAL,
  ORDER_COLUMNS,
  orderTotal,
  OrderTooSmallError,
  QUOTE_CURRENCY,
  toOrder,
  tradeAccounts,
  type MarketOrder,
  type Order,
} from "./orders.ts";

// See docs/design.md, "Orders". A limit buy fills once the price is at or below its limit, a limit
// sell once it's at or above. While it waits, what it would spend sits in the user's hold account,
// so two open orders can never be counting on the same cash or coins.

export type LimitOrder = MarketOrder & { limitPrice: bigint };

export class OrderNotOpenError extends Error {
  readonly order: Order;
  constructor(order: Order) {
    super(`order ${order.id} is ${order.status}`);
    this.order = order;
  }
}

/** The asset a pending order holds: the quote currency for a buy, the coin for a sell. */
function heldAsset(order: { side: string; symbol: string }): string {
  return order.side === "buy" ? QUOTE_CURRENCY : order.symbol;
}

/** Drops zero lines, which the ledger refuses. A fill can have one when nothing is left to give back. */
function nonZero(lines: Line[]): Line[] {
  return lines.filter((line) => line.amount !== 0n);
}

/**
 * Places a limit order: moves its cost at the limit price (buy) or its coins (sell) from the
 * user's balance into their hold account and saves the order as open. Must run in a transaction.
 * Throws InsufficientFundsError when the user doesn't have it.
 */
export async function placeLimitOrder(client: pg.ClientBase, userId: bigint, order: LimitOrder): Promise<Order> {
  const notional = orderTotal(order.quantity, order.limitPrice);
  if (notional < MIN_ORDER_TOTAL) throw new OrderTooSmallError();

  const asset = heldAsset(order);
  const holdAmount = order.side === "buy" ? notional : order.quantity;
  const from = await accountFor(client, userId, order.side === "buy" ? "cash" : "holding", asset);
  const hold = await accountFor(client, userId, "hold", asset);
  const holdEntryId = await postEntry(client, {
    kind: "hold",
    description: `Hold for limit ${order.side} ${order.symbol}`,
    lines: [
      { accountId: from, amount: -holdAmount },
      { accountId: hold, amount: holdAmount },
    ],
  });

  const { rows } = await client.query(
    `INSERT INTO orders (user_id, symbol, side, type, status, quantity, limit_price, currency, hold_amount, hold_entry_id)
     VALUES ($1, $2, $3, 'limit', 'open', $4, $5, $6, $7, $8)
     RETURNING ${ORDER_COLUMNS}`,
    [userId, order.symbol, order.side, order.quantity, order.limitPrice, QUOTE_CURRENCY, holdAmount, holdEntryId],
  );
  return toOrder(rows[0]);
}

/**
 * Cancels one of the user's open orders and gives back its hold. Must run in a transaction.
 * Returns null if the user has no such order; throws OrderNotOpenError if it already filled or
 * was cancelled. Locks the order row first, so a fill and a cancel racing for it run one at a time.
 */
export async function cancelOrder(client: pg.ClientBase, userId: bigint, orderId: bigint): Promise<Order | null> {
  const { rows } = await client.query(
    `SELECT ${ORDER_COLUMNS}, hold_amount FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE`,
    [orderId, userId],
  );
  if (!rows[0]) return null;
  const order = toOrder(rows[0]);
  if (order.status !== "open") throw new OrderNotOpenError(order);

  const asset = heldAsset(order);
  const holdAmount: bigint = rows[0].hold_amount;
  const back = await accountFor(client, userId, order.side === "buy" ? "cash" : "holding", asset);
  const hold = await accountFor(client, userId, "hold", asset);
  const releaseEntryId = await postEntry(client, {
    kind: "release",
    description: `Cancel limit ${order.side} ${order.symbol}`,
    lines: [
      { accountId: hold, amount: -holdAmount },
      { accountId: back, amount: holdAmount },
    ],
  });
  const updated = await client.query(
    `UPDATE orders SET status = 'cancelled', release_entry_id = $2, closed_at = now() WHERE id = $1
     RETURNING ${ORDER_COLUMNS}`,
    [orderId, releaseEntryId],
  );
  return toOrder(updated.rows[0]);
}

/** Whether a limit order would fill at `price`. */
export function crosses(order: { side: string; limitPrice: bigint | null }, price: bigint): boolean {
  if (order.limitPrice === null) return false;
  return order.side === "buy" ? price <= order.limitPrice : price >= order.limitPrice;
}

/**
 * Fills one open limit order at the tick's price, if it's still open, the price crosses its
 * limit, and it was placed before the tick. Must run in a transaction. Returns null if it skipped
 * the order, including when another transaction (a cancel, another worker) has it locked: that one
 * decides, and if it lets go, the next tick tries again.
 *
 * The fill is at the tick's price, which is the limit or better. A buy held its cost at the limit,
 * so whatever the fill didn't spend goes back to cash in the same entry.
 */
export async function fillLimitOrder(client: pg.ClientBase, orderId: bigint, tick: Tick): Promise<Order | null> {
  const { rows } = await client.query(
    `SELECT ${ORDER_COLUMNS}, user_id, hold_amount FROM orders
     WHERE id = $1 AND status = 'open' AND created_at <= to_timestamp($2::float8 / 1000)
     FOR UPDATE SKIP LOCKED`,
    [orderId, tick.time],
  );
  if (!rows[0]) return null;
  const order = toOrder(rows[0]);
  if (order.symbol !== tick.symbol || !crosses(order, tick.price)) return null;

  const userId: bigint = rows[0].user_id;
  const holdAmount: bigint = rows[0].hold_amount;
  const total = orderTotal(order.quantity, tick.price);
  const { userCash, houseCash, userCoin, houseCoin } = await tradeAccounts(client, userId, order.symbol);
  const hold = await accountFor(client, userId, "hold", heldAsset(order));

  const lines: Line[] =
    order.side === "buy"
      ? [
          { accountId: hold, amount: -holdAmount },
          { accountId: houseCash, amount: total },
          { accountId: userCash, amount: holdAmount - total },
          { accountId: userCoin, amount: order.quantity },
          { accountId: houseCoin, amount: -order.quantity },
        ]
      : [
          { accountId: hold, amount: -order.quantity },
          { accountId: houseCoin, amount: order.quantity },
          { accountId: houseCash, amount: -total },
          { accountId: userCash, amount: total },
        ];
  const entryId = await postEntry(client, {
    kind: "trade",
    description: `Limit ${order.side} ${order.symbol}`,
    lines: nonZero(lines),
  });

  const updated = await client.query(
    `UPDATE orders SET status = 'filled', price = $2, total = $3, entry_id = $4, closed_at = now() WHERE id = $1
     RETURNING ${ORDER_COLUMNS}`,
    [orderId, tick.price, total, entryId],
  );
  return toOrder(updated.rows[0]);
}

/** How many candidate orders to read at a time. */
const PAGE = 100;

/**
 * Fills every open limit order in `tick.symbol` that the tick's price crosses, oldest first, one
 * transaction per order so one bad order can't hold up the rest. If any order failed, throws once
 * the others are done, so the job is retried; orders that filled are no longer open and are skipped.
 */
export async function matchTick(pool: pg.Pool, tick: Tick): Promise<Order[]> {
  const filled: Order[] = [];
  const errors: unknown[] = [];
  let after = 0n;
  for (;;) {
    const { rows } = await pool.query<{ id: bigint }>(
      `SELECT id FROM orders
       WHERE status = 'open' AND symbol = $1 AND id > $3
         AND ((side = 'buy' AND limit_price >= $2) OR (side = 'sell' AND limit_price <= $2))
       ORDER BY id LIMIT ${PAGE}`,
      [tick.symbol, tick.price, after],
    );
    for (const { id } of rows) {
      try {
        const order = await withTransaction(pool, (client) => fillLimitOrder(client, id, tick));
        if (order) filled.push(order);
      } catch (err) {
        errors.push(err);
      }
    }
    if (rows.length < PAGE) break;
    after = rows[rows.length - 1]!.id;
  }
  if (errors.length > 0) throw new AggregateError(errors, `${errors.length} order(s) failed to fill`);
  return filled;
}
