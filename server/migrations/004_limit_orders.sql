-- Limit orders. See docs/design.md, "Orders".
--
-- A limit order waits as 'open' with its cash (for a buy) or coins (for a sell) moved into the
-- user's hold account by hold_entry_id. It ends either 'filled', with the fill in entry_id, or
-- 'cancelled', with the hold given back by release_entry_id.

ALTER TABLE orders
  DROP CONSTRAINT orders_type_check,
  ADD CONSTRAINT orders_type_check CHECK (type IN ('market', 'limit')),
  DROP CONSTRAINT orders_status_check,
  ADD CONSTRAINT orders_status_check CHECK (status IN ('open', 'filled', 'cancelled')),
  ALTER COLUMN price DROP NOT NULL,
  ALTER COLUMN total DROP NOT NULL,
  ALTER COLUMN entry_id DROP NOT NULL,
  -- 10^-8 of the quote currency per coin, like price.
  ADD COLUMN limit_price BIGINT CHECK (limit_price > 0),
  -- What was put on hold: cents for a buy, 10^-8 of a coin for a sell.
  ADD COLUMN hold_amount BIGINT CHECK (hold_amount > 0),
  ADD COLUMN hold_entry_id BIGINT REFERENCES journal_entries (id),
  ADD COLUMN release_entry_id BIGINT REFERENCES journal_entries (id),
  ADD COLUMN closed_at TIMESTAMPTZ,
  ADD CONSTRAINT orders_limit_fields CHECK (
    (type = 'limit') = (limit_price IS NOT NULL AND hold_amount IS NOT NULL AND hold_entry_id IS NOT NULL)
  ),
  ADD CONSTRAINT orders_filled_fields CHECK (
    (status = 'filled') = (price IS NOT NULL AND total IS NOT NULL AND entry_id IS NOT NULL)
  ),
  ADD CONSTRAINT orders_cancelled_fields CHECK ((status = 'cancelled') = (release_entry_id IS NOT NULL)),
  ADD CONSTRAINT orders_only_limit_orders_wait CHECK (status <> 'open' OR type = 'limit');

-- What the matcher reads on every tick: the open orders for one symbol that the price crosses.
CREATE INDEX orders_open_idx ON orders (symbol, side, limit_price) WHERE status = 'open';
