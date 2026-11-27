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

// See docs/design.md, "Orders". Pending orders wait for the price to come to them:
// - a limit buy fills once the price is at or below its limit, a limit sell once it's at or above;
// - a stop sell (stop-loss) fills once the price falls to its stop, at whatever that tick's price is.
// While an order waits, what it would spend sits in the user's hold account, so two open orders
// can never be counting on the same cash or coins.

export type LimitOrder = MarketOrder & { limitPrice: bigint };
export type StopOrder = MarketOrder & { side: "sell"; stopPrice: bigint };
export type PendingOrder = ({ type: "limit" } & LimitOrder) | ({ type: "stop" } & StopOrder);

/** A stop buy can't be held for (its fill price is open-ended), so stops are sells only. */
export class StopBuyError extends Error {}

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
 * Places a pending order: moves its cost at the limit price (limit buy) or its coins (any sell)
 * from the user's balance into their hold account and saves the order as open. Must run in a
 * transaction. Throws InsufficientFundsError when the user doesn't have it. The minimum order is
 * checked at the limit or stop price.
 */
export async function placePendingOrder(client: pg.ClientBase, userId: bigint, order: PendingOrder): Promise<Order> {
  if (order.type === "stop" && order.side !== "sell") throw new StopBuyError();
  const trigger = order.type === "limit" ? order.limitPrice : order.stopPrice;
  const notional = orderTotal(order.quantity, trigger);
  if (notional < MIN_ORDER_TOTAL) throw new OrderTooSmallError();

  const asset = heldAsset(order);
  const holdAmount = order.side === "buy" ? notional : order.quantity;
  const from = await accountFor(client, userId, order.side === "buy" ? "cash" : "holding", asset);
  const hold = await accountFor(client, userId, "hold", asset);
  const holdEntryId = await postEntry(client, {
    kind: "hold",
    description: `Hold for ${order.type} ${order.side} ${order.symbol}`,
    lines: [
      { accountId: from, amount: -holdAmount },
      { accountId: hold, amount: holdAmount },
    ],
  });

  const { rows } = await client.query(
    `INSERT INTO orders (user_id, symbol, side, type, status, quantity, limit_price, stop_price, currency,
                         hold_amount, hold_entry_id)
     VALUES ($1, $2, $3, $4, 'open', $5, $6, $7, $8, $9, $10)
     RETURNING ${ORDER_COLUMNS}`,
    [
      userId,
      order.symbol,
      order.side,
      order.type,
      order.quantity,
      order.type === "limit" ? order.limitPrice : null,
      order.type === "stop" ? order.stopPrice : null,
      QUOTE_CURRENCY,
      holdAmount,
      holdEntryId,
    ],
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
    description: `Cancel ${order.type} ${order.side} ${order.symbol}`,
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

type Trigger = { type: string; side: string; limitPrice: bigint | null; stopPrice: bigint | null };

/** Whether a pending order would fill at `price`. */
export function crosses(order: Trigger, price: bigint): boolean {
  if (order.type === "stop") return order.side === "sell" && order.stopPrice !== null && price <= order.stopPrice;
  if (order.type !== "limit" || order.limitPrice === null) return false;
  return order.side === "buy" ? price <= order.limitPrice : price >= order.limitPrice;
}

/**
 * Fills one open pending order at the tick's price, if it's still open, the price crosses its
 * limit or stop, and it was placed before the tick. Must run in a transaction. Returns null if it skipped
 * the order, including when another transaction (a cancel, another worker) has it locked: that one
 * decides, and if it lets go, the next tick tries again.
 *
 * The fill is at the tick's price. For a limit order that's the limit or better, and a buy held its
 * cost at the limit, so whatever the fill didn't spend goes back to cash in the same entry. For a
 * stop it can be below the stop when the price gaps down: a stop-loss limits a loss, it doesn't
 * promise a price.
 */
export async function fillPendingOrder(client: pg.ClientBase, orderId: bigint, tick: Tick): Promise<Order | null> {
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
    description: `${order.type === "stop" ? "Stop" : "Limit"} ${order.side} ${order.symbol}`,
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
 * Fills every open pending order in `tick.symbol` that the tick's price crosses, oldest first, one
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
         AND ((type = 'limit' AND side = 'buy' AND limit_price >= $2)
           OR (type = 'limit' AND side = 'sell' AND limit_price <= $2)
           OR (type = 'stop' AND stop_price >= $2))
       ORDER BY id LIMIT ${PAGE}`,
      [tick.symbol, tick.price, after],
    );
    for (const { id } of rows) {
      try {
        const order = await withTransaction(pool, (client) => fillPendingOrder(client, id, tick));
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
