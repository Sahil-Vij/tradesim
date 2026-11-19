import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";

export const REDIS_URL = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL;

// Same rule as the database: skipped locally without Redis, but never silently skipped in CI.
if (!REDIS_URL && process.env.CI) {
  throw new Error("REDIS_URL must be set in CI so the Redis tests run");
}
export const skipWithoutRedis = REDIS_URL
  ? false
  : "set REDIS_URL or TEST_REDIS_URL (run `docker compose up -d` and copy .env.example to .env)";

/** For tests whose routes never touch Redis: it never connects. */
export function offlineRedis(): Redis {
  return new Redis({ lazyConnect: true, enableOfflineQueue: false });
}

/**
 * A client whose keys all carry a random prefix, so test files don't see each other's prices.
 * `cleanup` deletes those keys and disconnects.
 */
export function createTestRedis(): { redis: Redis; cleanup: () => Promise<void> } {
  const prefix = `test:${randomBytes(6).toString("hex")}:`;
  const redis = new Redis(REDIS_URL!, { keyPrefix: prefix });
  return {
    redis,
    cleanup: async () => {
      // keyPrefix isn't applied to KEYS patterns' results, so delete with a plain client.
      const plain = new Redis(REDIS_URL!);
      const keys = await plain.keys(`${prefix}*`);
      if (keys.length) await plain.del(...keys);
      await Promise.all([plain.quit(), redis.quit()]);
    },
  };
}
