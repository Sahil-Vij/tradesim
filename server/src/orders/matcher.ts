import { Queue, Worker } from "bullmq";
import type pg from "pg";
import type { Tick } from "../prices/price.ts";
import { matchTick } from "./pending.ts";

// See docs/design.md, "Orders". The price worker adds a job for every new tick; order workers take
// jobs and fill the open orders that tick crosses. Any number of order workers can share the
// queue: each order is filled under a row lock, and one already filled is skipped.

export const MATCH_QUEUE = "order-matching";

type TickJob = { symbol: string; price: string; time: number };

export type QueueConnection = { url: string; prefix?: string };

export function matchQueue({ url, prefix }: QueueConnection): Queue<TickJob> {
  return new Queue<TickJob>(MATCH_QUEUE, {
    connection: { url },
    prefix,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 200 },
      // Keep a little history to look at, not every tick forever.
      removeOnComplete: 1_000,
      removeOnFail: 5_000,
    },
  });
}

/**
 * Queues a tick for matching. The job id is the symbol and the tick's time, so the same tick
 * added twice (a reconnect replaying it) is one job.
 */
export async function enqueueTick(queue: Queue<TickJob>, tick: Tick): Promise<void> {
  await queue.add(
    "tick",
    { symbol: tick.symbol, price: tick.price.toString(), time: tick.time },
    { jobId: `${tick.symbol}-${tick.time}` },
  );
}

export function startMatcher(options: QueueConnection & { pool: pg.Pool; concurrency?: number }): Worker<TickJob> {
  const { url, prefix, pool, concurrency = 4 } = options;
  return new Worker<TickJob>(
    MATCH_QUEUE,
    async (job) => {
      const { symbol, price, time } = job.data;
      const filled = await matchTick(pool, { symbol, price: BigInt(price), time });
      return { filled: filled.length };
    },
    // A worker blocks waiting for jobs, so its connection must never give up on a command.
    { connection: { url, maxRetriesPerRequest: null }, prefix, concurrency },
  );
}
