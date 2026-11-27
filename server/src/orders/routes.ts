import { Router, type RequestHandler } from "express";
import type { Redis } from "ioredis";
import type pg from "pg";
import { InsufficientFundsError, withTransaction } from "../ledger.ts";
import { PRICE_DECIMALS, STALE_AFTER_MS } from "../prices/price.ts";
import { latestTick } from "../prices/store.ts";
import { claimKey, requestHash, saveResponse, validKey, type Saved } from "./idempotency.ts";
import { cancelOrder, OrderNotOpenError, placePendingOrder, type PendingOrder } from "./pending.ts";
import { fillMarketOrder, OrderTooSmallError, TRADABLE, type MarketOrder, type Order } from "./orders.ts";

export type OrderOptions = { pool: pg.Pool; redis: Redis; requireAuth: RequestHandler; now?: () => number };

// Quantities come in as whole numbers of 10^-8 of a coin, as strings, like every amount in the API.
// Limit and stop prices likewise, in 10^-8 of a dollar per coin.
const AMOUNT = /^[1-9]\d{0,17}$/;
const ORDER_ID = /^[1-9]\d{0,17}$/;

type Parsed = ({ type: "market" } & MarketOrder) | PendingOrder;

function parseOrder(body: unknown): Parsed | { error: string } {
  const { symbol, side, type = "market", quantity, limitPrice, stopPrice } = (body ?? {}) as Record<string, unknown>;
  if (type !== "market" && type !== "limit" && type !== "stop") return { error: "unsupported_order_type" };
  if (typeof symbol !== "string" || !TRADABLE.has(symbol)) return { error: "unknown_symbol" };
  if (side !== "buy" && side !== "sell") return { error: "invalid_side" };
  if (typeof quantity !== "string" || !AMOUNT.test(quantity)) return { error: "invalid_quantity" };
  if (type === "market") return { type, symbol, side, quantity: BigInt(quantity) };
  if (type === "stop") {
    // A stop buy would fill at an unknown price, so there's no amount of cash to hold for it.
    if (side !== "sell") return { error: "stop_orders_are_sells" };
    if (typeof stopPrice !== "string" || !AMOUNT.test(stopPrice)) return { error: "invalid_stop_price" };
    return { type, symbol, side, quantity: BigInt(quantity), stopPrice: BigInt(stopPrice) };
  }
  if (typeof limitPrice !== "string" || !AMOUNT.test(limitPrice)) return { error: "invalid_limit_price" };
  return { type, symbol, side, quantity: BigInt(quantity), limitPrice: BigInt(limitPrice) };
}

/** The fields that make two requests "the same order", for the idempotency check. */
function hashOf(order: Parsed): Buffer {
  const fields: Record<string, string> = { symbol: order.symbol, side: order.side, quantity: String(order.quantity) };
  // Market orders keep the fields they always had, so keys saved before limit orders still match.
  if (order.type === "limit") Object.assign(fields, { type: "limit", limitPrice: String(order.limitPrice) });
  if (order.type === "stop") Object.assign(fields, { type: "stop", stopPrice: String(order.stopPrice) });
  return requestHash(fields);
}

const str = (n: bigint | null) => (n === null ? null : String(n));

function orderJson(order: Order) {
  return {
    id: String(order.id),
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    status: order.status,
    quantity: String(order.quantity),
    quantityDecimals: 8,
    ...(order.type === "limit" ? { limitPrice: str(order.limitPrice) } : {}),
    ...(order.type === "stop" ? { stopPrice: str(order.stopPrice) } : {}),
    price: str(order.price),
    priceDecimals: PRICE_DECIMALS,
    total: str(order.total),
    currency: order.currency,
    createdAt: order.createdAt.toISOString(),
    ...(order.type !== "market" ? { closedAt: order.closedAt?.toISOString() ?? null } : {}),
  };
}

export function ordersRouter({ pool, redis, requireAuth, now = Date.now }: OrderOptions): Router {
  const router = Router();

  router.post("/", requireAuth, async (req, res) => {
    const userId: bigint = res.locals.userId;
    const key = req.get("idempotency-key");
    if (!validKey(key)) {
      res.status(400).json({ error: "idempotency_key_required" });
      return;
    }
    const order = parseOrder(req.body);
    if ("error" in order) {
      res.status(400).json({ error: order.error });
      return;
    }

    // A market order needs a fresh price. Read it outside the transaction: it comes from Redis,
    // and holding row locks while waiting on another service makes every other order for this
    // user wait too. A limit or stop order doesn't: it waits for the price to come to it.
    let price: bigint | null = null;
    if (order.type === "market") {
      const tick = await latestTick(redis, order.symbol);
      if (tick && now() - tick.time <= STALE_AFTER_MS) price = tick.price;
    }

    let result: Saved & { replayed?: boolean };
    try {
      result = await withTransaction(pool, async (client) => {
        const claim = await claimKey(client, userId, key, hashOf(order));
        if (claim.kind === "replay") return { ...claim.saved, replayed: true };
        if (claim.kind === "mismatch") return { statusCode: 422, body: { error: "idempotency_key_reused" } };
        // Failures below throw, so the transaction (and the claimed key) rolls back and a retry
        // with the same key runs again. Only an order that was placed is saved.
        let placed: Order;
        if (order.type !== "market") {
          placed = await placePendingOrder(client, userId, order);
        } else {
          if (price === null) throw new StalePriceError();
          placed = await fillMarketOrder(client, userId, order, price);
        }
        const saved = { statusCode: 201, body: { order: orderJson(placed) } };
        await saveResponse(client, userId, key, saved);
        return saved;
      });
    } catch (err) {
      if (err instanceof InsufficientFundsError) {
        res.status(422).json({ error: order.side === "buy" ? "insufficient_funds" : "insufficient_holdings" });
        return;
      }
      if (err instanceof OrderTooSmallError) {
        res.status(422).json({ error: "order_too_small" });
        return;
      }
      if (err instanceof StalePriceError) {
        res.set("retry-after", "1").status(503).json({ error: "price_unavailable" });
        return;
      }
      throw err;
    }
    if (result.replayed) res.set("idempotent-replayed", "true");
    res.status(result.statusCode).json(result.body);
  });

  // Cancelling twice is harmless: the second one gets 409 with the order as it now is.
  router.delete("/:id", requireAuth, async (req, res) => {
    const id = String(req.params.id);
    if (!ORDER_ID.test(id)) {
      res.status(404).json({ error: "order_not_found" });
      return;
    }
    try {
      const order = await withTransaction(pool, (client) => cancelOrder(client, res.locals.userId, BigInt(id)));
      if (!order) {
        res.status(404).json({ error: "order_not_found" });
        return;
      }
      res.json({ order: orderJson(order) });
    } catch (err) {
      if (err instanceof OrderNotOpenError) {
        res.status(409).json({ error: "order_not_open", order: orderJson(err.order) });
        return;
      }
      throw err;
    }
  });

  return router;
}

class StalePriceError extends Error {}
