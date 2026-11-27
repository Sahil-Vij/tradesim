import express, { type ErrorRequestHandler } from "express";
import { createAuth, type AuthOptions } from "./auth/routes.ts";
import type { Redis } from "ioredis";
import { cashWallets } from "./ledger.ts";
import { ordersRouter } from "./orders/routes.ts";
import { PRICE_DECIMALS, STALE_AFTER_MS } from "./prices/price.ts";
import { latestTicks } from "./prices/store.ts";

export type AppOptions = AuthOptions & { redis: Redis; now?: () => number };

export function createApp(options: AppOptions) {
  const { pool, redis, now = Date.now } = options;
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
