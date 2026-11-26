import express, { type ErrorRequestHandler } from "express";
import { createAuth, type AuthOptions } from "./auth/routes.ts";
import type { Redis } from "ioredis";
import { cashWallets, holdings } from "./ledger.ts";
import { ordersRouter } from "./orders/routes.ts";
import { PRICE_DECIMALS, STALE_AFTER_MS } from "./prices/price.ts";
import { latestTicks } from "./prices/store.ts";
import { CandlesUnavailableError, getCandles, INTERVALS } from "./prices/candles.ts";
import { TRADABLE } from "./orders/orders.ts";

export type AppOptions = AuthOptions & {
  redis: Redis;
  now?: () => number;
  /** Where candles come from; tests point it at a local fake. */
  binanceRestUrl?: string;
};

export function createApp(options: AppOptions) {
  const { pool, redis, now = Date.now, binanceRestUrl } = options;
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  const auth = createAuth(options);
  app.use("/api/auth", auth.router);

  app.get("/api/me", auth.requireAuth, async (_req, res) => {
    const { rows } = await pool.query<{ id: bigint; email: string }>("SELECT id, email FROM users WHERE id = $1", [
      res.locals.userId,
    ]);
    if (!rows[0]) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.json({ id: String(rows[0].id), email: rows[0].email });
  });

  // Balances go out as strings in the smallest unit (paise, cents): JSON numbers would lose precision.
  app.get("/api/wallets", auth.requireAuth, async (_req, res) => {
    const wallets = await cashWallets(pool, res.locals.userId);
    res.json({ wallets: wallets.map((w) => ({ asset: w.asset, balance: String(w.balance), decimals: w.decimals })) });
  });

  app.get("/api/holdings", auth.requireAuth, async (_req, res) => {
    const rows = await holdings(pool, res.locals.userId);
    res.json({ holdings: rows.map((h) => ({ asset: h.asset, quantity: String(h.quantity), decimals: h.decimals })) });
  });

  app.use("/api/orders", ordersRouter({ pool, redis, requireAuth: auth.requireAuth, now }));

  // Public: prices aren't per-user. Same string-plus-decimals shape as wallets.
  app.get("/api/prices", async (_req, res) => {
    const at = now();
    const prices = (await latestTicks(redis)).map((t) => {
      const ageMs = Math.max(0, at - t.time);
      return {
        symbol: t.symbol,
        quote: "USD",
        price: String(t.price),
        decimals: PRICE_DECIMALS,
        time: new Date(t.time).toISOString(),
        ageMs,
        stale: ageMs > STALE_AFTER_MS,
      };
    });
    res.json({ prices });
  });

  // Public, like prices. GET /api/candles?symbol=BTC&interval=1m&limit=300
  app.get("/api/candles", async (req, res) => {
    const symbol = String(req.query.symbol ?? "");
    const interval = String(req.query.interval ?? "1m");
    const limit = req.query.limit === undefined ? 300 : Number(req.query.limit);
    if (!TRADABLE.has(symbol)) return void res.status(400).json({ error: "unknown_symbol" });
    if (!Object.hasOwn(INTERVALS, interval)) return void res.status(400).json({ error: "invalid_interval" });
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return void res.status(400).json({ error: "invalid_limit" });
    try {
      const candles = await getCandles(redis, symbol, interval, limit, binanceRestUrl);
      res.json({
        symbol,
        interval,
        priceDecimals: PRICE_DECIMALS,
        candles: candles.map((c) => ({
          time: c.time,
          open: String(c.open),
          high: String(c.high),
          low: String(c.low),
          close: String(c.close),
          volume: String(c.volume),
        })),
      });
    } catch (err) {
      if (!(err instanceof CandlesUnavailableError)) throw err;
      console.error(err.message);
      res.set("retry-after", "5").status(502).json({ error: "candles_unavailable" });
    }
  });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    // Body parser errors carry a 4xx status; anything else is our bug.
    const status = typeof err?.status === "number" && err.status < 500 ? err.status : 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: status === 500 ? "internal_error" : "bad_request" });
  };
  app.use(onError);

  return app;
}
