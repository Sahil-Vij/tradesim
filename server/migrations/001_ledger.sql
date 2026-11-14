-- Users, accounts and the double-entry ledger. See docs/design.md, "Money".

CREATE TABLE users (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_email_lowercase CHECK (email = lower(email))
);
CREATE UNIQUE INDEX users_email_key ON users (email);

-- An account holds one asset: a currency like INR or USD, or a tradable asset like BTC.
-- user_id is NULL for the house accounts that sit on the other side of every trade.
-- balance is a cache of the sum of the account's journal lines, kept in step by the ledger code.
CREATE TABLE accounts (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT REFERENCES users (id),
  kind       TEXT NOT NULL CHECK (kind IN ('cash', 'holding', 'hold', 'house')),
  asset      TEXT NOT NULL CHECK (asset ~ '^[A-Z0-9]{2,12}$'),
  balance    BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT accounts_house_has_no_user CHECK ((kind = 'house') = (user_id IS NULL)),
  CONSTRAINT accounts_user_balance_not_negative CHECK (user_id IS NULL OR balance >= 0),
  CONSTRAINT accounts_one_per_kind_and_asset UNIQUE NULLS NOT DISTINCT (user_id, kind, asset),
  -- Lets journal_lines reference (id, asset), so a line can't carry a different asset from its account.
  CONSTRAINT accounts_id_asset_key UNIQUE (id, asset)
);

CREATE TABLE journal_entries (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Amounts are integers in the asset's smallest unit: paise, cents, or 10^-8 of a coin or share.
CREATE TABLE journal_lines (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id   BIGINT NOT NULL REFERENCES journal_entries (id),
  account_id BIGINT NOT NULL,
  asset      TEXT NOT NULL,
  amount     BIGINT NOT NULL CHECK (amount <> 0),
  FOREIGN KEY (account_id, asset) REFERENCES accounts (id, asset)
);
CREATE INDEX journal_lines_entry_id_idx ON journal_lines (entry_id);
CREATE INDEX journal_lines_account_id_idx ON journal_lines (account_id);

-- Every entry must balance: for each asset, its lines sum to zero.
-- The check runs at commit, so an entry's lines can be inserted one at a time.
CREATE FUNCTION journal_entry_must_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  unbalanced TEXT;
BEGIN
  SELECT asset INTO unbalanced
  FROM journal_lines
  WHERE entry_id = NEW.entry_id
  GROUP BY asset
  HAVING sum(amount) <> 0
  LIMIT 1;

  IF unbalanced IS NOT NULL THEN
    RAISE EXCEPTION 'journal entry % does not balance for %', NEW.entry_id, unbalanced
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER journal_lines_balance
  AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION journal_entry_must_balance();

-- The ledger is append-only. Mistakes are fixed with a reversing entry, never by editing history.
CREATE FUNCTION ledger_is_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER journal_entries_append_only
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_is_append_only();

CREATE TRIGGER journal_lines_append_only
  BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION ledger_is_append_only();
