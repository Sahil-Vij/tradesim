import type { Redis } from "ioredis";
import type { Tick } from "./price.ts";

/** Hash of symbol → latest tick. One HGETALL reads every price. */
export const PRICES_KEY = "prices:latest";
/** Pub/sub channel each tick is published on, for the order worker and the WebSocket gateway. */
export const TICKS_CHANNEL = "prices:ticks";

type Stored = { price: string; time: number };

/**
 * Saves a tick as the latest price and publishes it. A tick older than the stored one is dropped,
 * so a late message from a replaced connection can't overwrite a newer price.
 */
const SAVE_IF_NEWER = `
local current = redis.call('HGET', KEYS[1], ARGV[1])
if current and cjson.decode(current).time >= tonumber(ARGV[3]) then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('PUBLISH', ARGV[4], ARGV[5])
return 1
`;

export async function saveTick(redis: Redis, tick: Tick): Promise<boolean> {
  const stored = JSON.stringify({ price: tick.price.toString(), time: tick.time } satisfies Stored);
  const message = JSON.stringify({ symbol: tick.symbol, price: tick.price.toString(), time: tick.time });
  const saved = await redis.eval(SAVE_IF_NEWER, 1, PRICES_KEY, tick.symbol, stored, tick.time, TICKS_CHANNEL, message);
  return saved === 1;
}

export async function latestTicks(redis: Redis): Promise<Tick[]> {
  const all = await redis.hgetall(PRICES_KEY);
  return Object.entries(all)
    .map(([symbol, value]) => {
      const { price, time } = JSON.parse(value) as Stored;
      return { symbol, price: BigInt(price), time };
    })
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}
