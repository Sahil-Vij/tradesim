import { randomUUID } from "node:crypto";
import type pg from "pg";
import { hashRefreshToken, newRefreshToken, REFRESH_TOKEN_DAYS } from "./tokens.ts";

async function issue(db: pg.Pool | pg.PoolClient, userId: bigint, familyId: string): Promise<string> {
  const { token, hash } = newRefreshToken();
  await db.query(
    `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
    [userId, familyId, hash, REFRESH_TOKEN_DAYS],
  );
  return token;
}

/** Starts a new session (a new token family) and returns its first refresh token. */
export function startSession(pool: pg.Pool, userId: bigint): Promise<string> {
  return issue(pool, userId, randomUUID());
}

export type Rotation = { userId: bigint; token: string } | { error: "invalid" | "reused" };

/**
 * Swaps a refresh token for a new one in the same family. A token that was already swapped means a copy
 * exists somewhere, so the whole family is revoked and the user has to sign in again.
 */
export async function rotateSession(pool: pg.Pool, token: string): Promise<Rotation> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // FOR UPDATE makes concurrent refreshes with the same token take turns, so only one can win.
    const { rows } = await client.query<{
      id: bigint;
      user_id: bigint;
      family_id: string;
      expired: boolean;
      replaced: boolean;
      revoked: boolean;
    }>(
      `SELECT id, user_id, family_id, expires_at <= now() AS expired,
              replaced_at IS NOT NULL AS replaced, revoked_at IS NOT NULL AS revoked
       FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
      [hashRefreshToken(token)],
    );
    const row = rows[0];
    let result: Rotation;
    if (!row || row.revoked || row.expired) {
      result = { error: "invalid" };
    } else if (row.replaced) {
      await client.query("UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL", [
        row.family_id,
      ]);
      result = { error: "reused" };
    } else {
      await client.query("UPDATE refresh_tokens SET replaced_at = now() WHERE id = $1", [row.id]);
      result = { userId: row.user_id, token: await issue(client, row.user_id, row.family_id) };
    }
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Ends the session the token belongs to, including tokens it was swapped for. */
export async function endSession(pool: pg.Pool, token: string): Promise<void> {
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = now()
     WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1) AND revoked_at IS NULL`,
    [hashRefreshToken(token)],
  );
}
