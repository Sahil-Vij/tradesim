import { loadDatabaseUrl } from "../config.ts";
import { migrate } from "./migrate.ts";
import { createPool } from "./pool.ts";

const pool = createPool(loadDatabaseUrl());
try {
  const ran = await migrate(pool);
  console.log(ran.length ? `Applied ${ran.join(", ")}` : "Database is up to date");
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
