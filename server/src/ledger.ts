import type pg from "pg";

// See docs/design.md, "Money". Amounts are BigInt in the asset's smallest unit.

export type AccountKind = "cash" | "holding" | "hold" | "house";

/** Decimal places of each asset's smallest unit: paise and cents for cash, 10^-8 for coins and shares. */
export function decimalsOf(asset: string): number {
  return asset === "INR" || asset === "USD" ? 2 : 8;
}

/** What every new user starts with: ₹10,00,000 and $10,000. */
export const OPENING_BALANCES: ReadonlyArray<{ asset: string; amount: bigint }> = [
  { asset: "INR", amount: 10_00_000_00n },
  { asset: "USD", amount: 10_000_00n },
];

export class UnbalancedEntryError extends Error {}

/** A user account would go below zero. The transaction is aborted and must be rolled back. */
export class InsufficientFundsError extends Error {
  constructor() {
    super("insufficient funds");
  }
}

/** Runs `fn` in a transaction and commits, or rolls back if it throws. */
export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** The id of the user's (or, with `userId` null, the house's) account for an asset, created on first use. */
export async function accountFor(
  client: pg.ClientBase,
  userId: bigint | null,
  kind: AccountKind,
  asset: string,
): Promise<bigint> {
  // If another transaction is creating the same account, this waits for it and then finds its row.
  await client.query(
    `INSERT INTO accounts (user_id, kind, asset) VALUES ($1, $2, $3)
     ON CONFLICT ON CONSTRAINT accounts_one_per_kind_and_asset DO NOTHING`,
    [userId, kind, asset],
  );
  const { rows } = await client.query<{ id: bigint }>(
    "SELECT id FROM accounts WHERE user_id IS NOT DISTINCT FROM $1 AND kind = $2 AND asset = $3",
    [userId, kind, asset],
  );
  return rows[0]!.id;
}

export type Line = { accountId: bigint; amount: bigint };

/**
 * Writes one journal entry and updates the cached balances of the user accounts it touches.
 * Must run inside a transaction; the caller commits.
 *
 * House accounts are the other side of every user's trades, so locking them would make every
 * trade in the system wait on one row. Nothing is ever checked against a house balance, so it
 * isn't cached: it's the sum of the house account's lines.
 */
export async function postEntry(
  client: pg.ClientBase,
  entry: { kind: string; description?: string; lines: Line[] },
): Promise<bigint> {
  const { lines } = entry;
  if (lines.length < 2 || lines.some((line) => line.amount === 0n)) {
    throw new UnbalancedEntryError("an entry needs at least two non-zero lines");
  }

  // Lock in id order, so two entries touching the same accounts can't deadlock.
  const ids = [...new Set(lines.map((line) => line.accountId))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const { rows: accounts } = await client.query<{ id: bigint; asset: string; user_id: bigint | null }>(
    "SELECT id, asset, user_id FROM accounts WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE",
    [ids.map(String)],
  );
  if (accounts.length !== ids.length) throw new Error("entry refers to an account that doesn't exist");
  const byId = new Map(accounts.map((account) => [account.id, account]));

  // The database checks this too, at commit. Checking here gives a clear error before anything is written.
  const sums = new Map<string, bigint>();
  for (const line of lines) {
    const asset = byId.get(line.accountId)!.asset;
    sums.set(asset, (sums.get(asset) ?? 0n) + line.amount);
  }
  for (const [asset, sum] of sums) {
    if (sum !== 0n) throw new UnbalancedEntryError(`entry is off by ${sum} for ${asset}`);
  }

  const { rows } = await client.query<{ id: bigint }>(
    "INSERT INTO journal_entries (kind, description) VALUES ($1, $2) RETURNING id",
    [entry.kind, entry.description ?? ""],
  );
  const entryId = rows[0]!.id;

  await client.query(
    `INSERT INTO journal_lines (entry_id, account_id, asset, amount)
     SELECT $1, line.account_id, line.asset, line.amount
     FROM unnest($2::bigint[], $3::text[], $4::bigint[]) AS line (account_id, asset, amount)`,
    [
      entryId,
      lines.map((line) => String(line.accountId)),
      lines.map((line) => byId.get(line.accountId)!.asset),
      lines.map((line) => String(line.amount)),
    ],
  );

  const userLines = lines.filter((line) => byId.get(line.accountId)!.user_id !== null);
  if (userLines.length > 0) {
    try {
      await client.query(
        `UPDATE accounts SET balance = accounts.balance + delta.amount
         FROM (SELECT account_id, sum(amount)::bigint AS amount
               FROM unnest($1::bigint[], $2::bigint[]) AS line (account_id, amount)
               GROUP BY account_id) AS delta
         WHERE accounts.id = delta.account_id`,
        [userLines.map((line) => String(line.accountId)), userLines.map((line) => String(line.amount))],
      );
    } catch (err) {
      if ((err as { constraint?: string }).constraint === "accounts_user_balance_not_negative") {
        throw new InsufficientFundsError();
      }
      throw err;
    }
  }
  return entryId;
}

/** Opens a new user's cash accounts and pays in the starting balances from the house, as one entry. */
export async function openWallets(client: pg.ClientBase, userId: bigint): Promise<void> {
  const lines: Line[] = [];
  for (const { asset, amount } of OPENING_BALANCES) {
    lines.push({ accountId: await accountFor(client, null, "house", asset), amount: -amount });
    lines.push({ accountId: await accountFor(client, userId, "cash", asset), amount });
  }
  await postEntry(client, { kind: "opening", description: "Starting balance", lines });
}

export type Wallet = { asset: string; balance: bigint; decimals: number };

/** A user's cash balances, INR first. */
export async function cashWallets(pool: pg.Pool, userId: bigint): Promise<Wallet[]> {
  const { rows } = await pool.query<{ asset: string; balance: bigint }>(
    "SELECT asset, balance FROM accounts WHERE user_id = $1 AND kind = 'cash' ORDER BY asset = 'INR' DESC, asset",
    [userId],
  );
  return rows.map((row) => ({ ...row, decimals: decimalsOf(row.asset) }));
}

/** User accounts whose cached balance differs from the sum of their lines. Should always be empty. */
export async function driftedAccounts(
  client: pg.ClientBase,
): Promise<Array<{ id: bigint; balance: bigint; fromLines: bigint }>> {
  const { rows } = await client.query<{ id: bigint; balance: bigint; from_lines: bigint }>(
    `SELECT a.id, a.balance, coalesce(sum(l.amount), 0)::bigint AS from_lines
     FROM accounts a LEFT JOIN journal_lines l ON l.account_id = a.id
     WHERE a.user_id IS NOT NULL
     GROUP BY a.id
     HAVING a.balance <> coalesce(sum(l.amount), 0)`,
  );
  return rows.map(({ id, balance, from_lines }) => ({ id, balance, fromLines: from_lines }));
}
