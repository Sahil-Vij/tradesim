-- Orders and idempotency keys. See docs/design.md, "Orders".

-- Quantities are in units of 10^-8 of a coin. Prices are 10^-8 of the quote currency per coin.
-- total is what the user paid or received, in the quote currency's smallest unit (cents).
CREATE TABLE orders (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users (id),
  symbol     TEXT NOT NULL CHECK (symbol ~ '^[A-Z0-9]{2,12}$'),
  side       TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  type       TEXT NOT NULL CHECK (type IN ('market')),
  status     TEXT NOT NULL CHECK (status IN ('filled')),
  quantity   BIGINT NOT NULL CHECK (quantity > 0),
  price      BIGINT NOT NULL CHECK (price > 0),
  total      BIGINT NOT NULL CHECK (total > 0),
  currency   TEXT NOT NULL,
  entry_id   BIGINT NOT NULL REFERENCES journal_entries (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX orders_user_id_created_at_idx ON orders (user_id, created_at DESC);

-- One row per (user, key). The row is inserted at the start of the order's transaction, so a
-- second request with the same key waits on it, then sees the saved response. Only completed
-- requests are kept: if the order fails, the transaction rolls back and the key can be used again.
CREATE TABLE idempotency_keys (
  user_id      BIGINT NOT NULL REFERENCES users (id),
  key          TEXT NOT NULL,
  request_hash BYTEA NOT NULL,
  status_code  INT,
  -- JSON, not JSONB: JSONB reorders keys, and a replay should be the same bytes as the original.
  response     JSON,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
