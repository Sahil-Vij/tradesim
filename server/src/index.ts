import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const server = createApp().listen(config.port, () => {
  console.log(`tradesim server listening on http://localhost:${config.port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
