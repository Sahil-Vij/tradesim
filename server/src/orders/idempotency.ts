import { createHash } from "node:crypto";
import type pg from "pg";

// See docs/design.md, "Orders". A key belongs to one user, so two users can't collide.

const KEY = /^[\x21-\x7e]{1,255}$/; // printable ASCII, no spaces, like a UUID

export function validKey(key: string | undefined): key is string {
  return key !== undefined && KEY.test(key);
}

/** A hash of the request's meaning, so the same key can be checked against the same request. */
export function requestHash(request: Record<string, string>): Buffer {
  const canonical = JSON.stringify(Object.keys(request).sort().map((k) => [k, request[k]]));
  return createHash("sha256").update(canonical).digest();
}

export type Saved = { statusCode: number; body: unknown };

export type Claim =
  | { kind: "new" }
  | { kind: "replay"; saved: Saved }
  /** The key was used for a different request. */
  | { kind: "mismatch" };

/**
 * Claims `key` for this request inside the caller's transaction. If another transaction holds the
 * same key, the insert waits until it commits (then this sees its saved response) or rolls back
 * (then the claim is ours). So a double click runs the order once, and the second click gets the
 * first one's answer instead of an error.
 */
export async function claimKey(client: pg.ClientBase, userId: bigint, key: string, hash: Buffer): Promise<Claim> {
  const inserted = await client.query(
    `INSERT INTO idempotency_keys (user_id, key, request_hash) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, key) DO NOTHING`,
    [userId, key, hash],
  );
  if (inserted.rowCount === 1) return { kind: "new" };

  const { rows } = await client.query<{ request_hash: Buffer; status_code: number; response: unknown }>(
    "SELECT request_hash, status_code, response FROM idempotency_keys WHERE user_id = $1 AND key = $2",
    [userId, key],
  );
  const row = rows[0]!;
  if (!row.request_hash.equals(hash)) return { kind: "mismatch" };
  return { kind: "replay", saved: { statusCode: row.status_code, body: row.response } };
}

export async function saveResponse(client: pg.ClientBase, userId: bigint, key: string, saved: Saved): Promise<void> {
  await client.query("UPDATE idempotency_keys SET status_code = $3, response = $4 WHERE user_id = $1 AND key = $2", [
    userId,
    key,
    saved.statusCode,
    JSON.stringify(saved.body),
  ]);
}
