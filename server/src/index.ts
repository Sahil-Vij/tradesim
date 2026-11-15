import { createApp } from "./app.ts";
import { loadConfig, loadDatabaseUrl } from "./config.ts";
import { createPool } from "./db/pool.ts";

const config = loadConfig();
const pool = createPool(loadDatabaseUrl());
const app = createApp({ pool, jwtSecret: config.jwtSecret, secureCookies: config.secureCookies });
const server = app.listen(config.port, () => {
  console.log(`tradesim server listening on http://localhost:${config.port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => pool.end().then(() => process.exit(0))));
}
