import { loadDatabaseUrl, loadRedisUrl } from "./config.ts";
import { createPool } from "./db/pool.ts";
import { startMatcher } from "./orders/matcher.ts";

// Fills open limit orders as prices move. Run as many as needed; they share one queue.
const pool = createPool(loadDatabaseUrl());
const worker = startMatcher({ url: loadRedisUrl(), pool });
worker.on("failed", (job, err) => {
  console.error(`matching ${job?.id} failed (attempt ${job?.attemptsMade}):`, err);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    worker.close().then(() => pool.end()).then(() => process.exit(0));
  });
}
