import { Redis } from "ioredis";
import { createApp } from "./app.ts";
import { loadConfig, loadDatabaseUrl, loadRedisUrl } from "./config.ts";
import { createPool } from "./db/pool.ts";

const config = loadConfig();
const pool = createPool(loadDatabaseUrl());
const redis = new Redis(loadRedisUrl());
const app = createApp({ pool, redis, jwtSecret: config.jwtSecret, secureCookies: config.secureCookies });
const server = app.listen(config.port, () => {
  console.log(`tradesim server listening on http://localhost:${config.port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => Promise.all([pool.end(), redis.quit()]).then(() => process.exit(0))));
}
