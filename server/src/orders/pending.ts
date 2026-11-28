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
// - a stop sell (stop-loss) fills once the price falls to its stop, at whatever that tick's price is;
// - a bracket is a limit buy that, when it fills, opens a take-profit limit sell and a stop-loss
//   sell for the same coins. Whichever of those two fills first cancels the other.
// While an order waits, what it would spend sits in the user's hold account, so two open orders
// can never be counting on the same cash or coins. A bracket's two children are the exception:
// they share one hold, which is safe because only one of them can ever fill.

export type LimitOrder = MarketOrder & { limitPrice: bigint };
export type StopOrder = MarketOrder & { side: "sell"; stopPrice: bigint };
export type BracketOrder = LimitOrder & { side: "buy"; takeProfitPrice: bigint; stopLossPrice: bigint };
export type PendingOrder =
  | ({ type: "limit" } & LimitOrder)
  | ({ type: "stop" } & StopOrder)
  | ({ type: "bracket" } & BracketOrder);

/** A stop buy can't be held for (its fill price is open-ended), so stops are sells only. */
export class StopBuyError extends Error {}

/** A bracket needs stop loss < limit < take profit, and is a buy. */
export class BracketPricesError extends Error {}

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
 * Places a pending order: moves its cost at the limit price (limit or bracket buy) or its coins
 * (any sell) from the user's balance into their hold account and saves the order as open. Must
 * run in a transaction. Throws InsufficientFundsError when the user doesn't have it. The minimum
 * order is checked at the limit or stop price.
 */
export async function placePendingOrder(client: pg.ClientBase, userId: bigint, order: PendingOrder): Promise<Order> {
  if (order.type === "stop" && order.side !== "sell") throw new StopBuyError();
  if (
    order.type === "bracket" &&
    !(order.side === "buy" && order.stopLossPrice < order.limitPrice && order.limitPrice < order.takeProfitPrice)
  ) {
    throw new BracketPricesError();
  }
  const trigger = order.type === "stop" ? order.stopPrice : order.limitPrice;
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
    `INSERT INTO orders (user_id, symbol, side, type, status, quantity, limit_price, stop_price,
                         take_profit_price, stop_loss_price, currency, hold_amount, hold_entry_id)
     VALUES ($1, $2, $3, $4, 'open', $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING ${ORDER_COLUMNS}`,
    [
      userId,
      order.symbol,
      order.side,
      order.type,
      order.quantity,
      order.type === "stop" ? null : order.limitPrice,
      order.type === "stop" ? order.stopPrice : null,
      order.type === "bracket" ? order.takeProfitPrice : null,
      order.type === "bracket" ? order.stopLossPrice : null,
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
 *
 * Cancelling either child of a bracket cancels both: they hold the same coins, so there's one
 * hold to give back. The bracket row is locked before the children, the same order a fill uses.
 */
export async function cancelOrder(client: pg.ClientBase, userId: bigint, orderId: bigint): Promise<Order | null> {
  const { rows: found } = await client.query<{ parent_id: bigint | null }>(
    "SELECT parent_id FROM orders WHERE id = $1 AND user_id = $2",
    [orderId, userId],
  );
  if (!found[0]) return null;
  const parentId = found[0].parent_id;
  if (parentId !== null) await client.query("SELECT 1 FROM orders WHERE id = $1 FOR UPDATE", [parentId]);

  const { rows } = await client.query(
    `SELECT ${ORDER_COLUMNS}, hold_amount FROM orders WHERE id = $1 FOR UPDATE`,
    [orderId],
  );
  const order = toOrder(rows[0]);
  if (order.status !== "open") throw new OrderNotOpenError(order);

  const asset = heldAsset(order);
  const holdAmount: bigint = rows[0].hold_amount;
  const back = await accountFor(client, userId, order.side === "buy" ? "cash" : "holding", asset);
  const hold = await accountFor(client, userId, "hold", asset);
  const releaseEntryId = await postEntry(client, {
    kind: "release",
    description: `Cancel ${parentId === null ? order.type : "bracket"} ${order.side} ${order.symbol}`,
    lines: [
      { accountId: hold, amount: -holdAmount },
      { accountId: back, amount: holdAmount },
    ],
  });
  const updated = await client.query(
    `UPDATE orders SET status = 'cancelled', release_entry_id = $2, closed_at = now()
     WHERE status = 'open' AND (id = $1 OR ($3::bigint IS NOT NULL AND parent_id = $3))
     RETURNING ${ORDER_COLUMNS}`,
    [orderId, releaseEntryId, parentId],
  );
  return toOrder(updated.rows.find((row) => row.id === orderId));
}

type Trigger = { type: string; side: string; limitPrice: bigint | null; stopPrice: bigint | null };

/** Whether a pending order would fill at `price`. */
export function crosses(order: Trigger, price: bigint): boolean {
  if (order.type === "stop") return order.side === "sell" && order.stopPrice !== null && price <= order.stopPrice;
  if ((order.type !== "limit" && order.type !== "bracket") || order.limitPrice === null) return false;
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
 *
 * A bracket fills like a limit buy, except the coins go to the hold account and its two children
 * are created in the same transaction. They're dated just after the tick, so the tick that filled
 * the bracket never fills a child; the next one can. A child is filled with its bracket's row
 * locked first, so two workers on two ticks can't fill both children at once: the second waits,
 * finds its order cancelled, and skips it.
 */
export async function fillPendingOrder(client: pg.ClientBase, orderId: bigint, tick: Tick): Promise<Order | null> {
  const { rows: found } = await client.query<{ parent_id: bigint | null }>(
    "SELECT parent_id FROM orders WHERE id = $1",
    [orderId],
  );
  const parentId = found[0]?.parent_id ?? null;
  if (parentId !== null) {
    const locked = await client.query("SELECT 1 FROM orders WHERE id = $1 FOR UPDATE SKIP LOCKED", [parentId]);
    if (locked.rowCount === 0) return null;
  }

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

  let lines: Line[];
  if (order.side === "buy") {
    // A bracket's coins are for its children to sell, so they go on hold, not to the user's balance.
    const coinsTo = order.type === "bracket" ? await accountFor(client, userId, "hold", order.symbol) : userCoin;
    lines = [
      { accountId: hold, amount: -holdAmount },
      { accountId: houseCash, amount: total },
      { accountId: userCash, amount: holdAmount - total },
      { accountId: coinsTo, amount: order.quantity },
      { accountId: houseCoin, amount: -order.quantity },
    ];
  } else {
    lines = [
      { accountId: hold, amount: -order.quantity },
      { accountId: houseCoin, amount: order.quantity },
      { accountId: houseCash, amount: -total },
      { accountId: userCash, amount: total },
    ];
  }
  const label = { limit: "Limit", stop: "Stop", bracket: "Bracket", market: "Market" }[order.type];
  const entryId = await postEntry(client, {
    kind: "trade",
    description: `${parentId === null ? label : `Bracket ${label.toLowerCase()}`} ${order.side} ${order.symbol}`,
    lines: nonZero(lines),
  });

  const updated = await client.query(
    `UPDATE orders SET status = 'filled', price = $2, total = $3, entry_id = $4, closed_at = now() WHERE id = $1
     RETURNING ${ORDER_COLUMNS}`,
    [orderId, tick.price, total, entryId],
  );

  if (order.type === "bracket") {
    await client.query(
      `INSERT INTO orders (user_id, symbol, side, type, status, quantity, limit_price, stop_price, currency,
                           hold_amount, hold_entry_id, parent_id, created_at)
       SELECT user_id, symbol, 'sell', child.type, 'open', quantity, child.limit_price, child.stop_price, currency,
              quantity, $2, id, greatest(now(), to_timestamp($3::float8 / 1000) + interval '1 millisecond')
       FROM orders
       CROSS JOIN LATERAL (VALUES ('limit', take_profit_price, NULL::bigint), ('stop', NULL::bigint, stop_loss_price))
         AS child (type, limit_price, stop_price)
       WHERE id = $1`,
      [orderId, entryId, tick.time],
    );
  } else if (parentId !== null) {
    // One cancels the other. Its share of the hold just left in this fill, so this entry released it.
    await client.query(
      `UPDATE orders SET status = 'cancelled', release_entry_id = $3, closed_at = now()
       WHERE parent_id = $1 AND id <> $2 AND status = 'open'`,
      [parentId, orderId, entryId],
    );
  }
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
         AND ((type IN ('limit', 'bracket') AND side = 'buy' AND limit_price >= $2)
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
