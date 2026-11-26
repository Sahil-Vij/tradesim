import { Router, type RequestHandler } from "express";
import type { Redis } from "ioredis";
import type pg from "pg";
import { InsufficientFundsError, withTransaction } from "../ledger.ts";
import { PRICE_DECIMALS, STALE_AFTER_MS } from "../prices/price.ts";
import { latestTick } from "../prices/store.ts";
import { claimKey, requestHash, saveResponse, validKey, type Saved } from "./idempotency.ts";
import { fillMarketOrder, OrderTooSmallError, TRADABLE, type FilledOrder, type MarketOrder } from "./orders.ts";

export type OrderOptions = { pool: pg.Pool; redis: Redis; requireAuth: RequestHandler; now?: () => number };

// Quantities come in as whole numbers of 10^-8 of a coin, as strings, like every amount in the API.
const QUANTITY = /^[1-9]\d{0,17}$/;

function parseOrder(body: unknown): MarketOrder | { error: string } {
  const { symbol, side, type = "market", quantity } = (body ?? {}) as Record<string, unknown>;
  if (type !== "market") return { error: "unsupported_order_type" };
  if (typeof symbol !== "string" || !TRADABLE.has(symbol)) return { error: "unknown_symbol" };
  if (side !== "buy" && side !== "sell") return { error: "invalid_side" };
  if (typeof quantity !== "string" || !QUANTITY.test(quantity)) return { error: "invalid_quantity" };
  return { symbol, side, quantity: BigInt(quantity) };
}

function orderJson(order: FilledOrder) {
  return {
    id: String(order.id),
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    status: order.status,
    quantity: String(order.quantity),
    quantityDecimals: 8,
    price: String(order.price),
    priceDecimals: PRICE_DECIMALS,
    total: String(order.total),
    currency: order.currency,
    createdAt: order.createdAt.toISOString(),
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

    // Read the price outside the transaction: it comes from Redis, and holding row locks while
    // waiting on another service makes every other order for this user wait too.
    const tick = await latestTick(redis, order.symbol);
    const stale = !tick || now() - tick.time > STALE_AFTER_MS;

    const hash = requestHash({ symbol: order.symbol, side: order.side, quantity: String(order.quantity) });
    let result: Saved & { replayed?: boolean };
    try {
      result = await withTransaction(pool, async (client) => {
        const claim = await claimKey(client, userId, key, hash);
        if (claim.kind === "replay") return { ...claim.saved, replayed: true };
        if (claim.kind === "mismatch") return { statusCode: 422, body: { error: "idempotency_key_reused" } };
        // Failures below throw, so the transaction (and the claimed key) rolls back and a retry
        // with the same key runs again. Only a fill is saved.
        if (stale) throw new StalePriceError();
        const filled = await fillMarketOrder(client, userId, order, tick!.price);
        const saved = { statusCode: 201, body: { order: orderJson(filled) } };
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

  return router;
}

class StalePriceError extends Error {}
