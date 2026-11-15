import express, { type ErrorRequestHandler } from "express";
import { createAuth, type AuthOptions } from "./auth/routes.ts";

export function createApp(options: AuthOptions) {
  const { pool } = options;
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
