-- Bracket orders. See docs/design.md, "Orders".
--
-- A bracket is a limit buy (the parent, type 'bracket') that carries a take-profit price above its
-- limit and a stop-loss price below it. It waits and holds cash like a limit buy. When it fills,
-- the coins go straight to the user's hold account and two child sells are created in the same
-- transaction: a limit sell at the take-profit price and a stop sell at the stop-loss price, both
-- for the whole quantity, both pointing at the parent with parent_id.
--
-- The two children share one hold: the coins are held once, by the parent's fill entry, which is
-- each child's hold_entry_id. When one child fills, the other is cancelled in the same transaction,
-- and its release_entry_id is that fill: the entry where the shared hold left. Cancelling either
-- child cancels both and gives the coins back with one release entry.

ALTER TABLE orders
  DROP CONSTRAINT orders_type_check,
  ADD CONSTRAINT orders_type_check CHECK (type IN ('market', 'limit', 'stop', 'bracket')),
  -- 10^-8 of the quote currency per coin, like limit_price.
  ADD COLUMN take_profit_price BIGINT CHECK (take_profit_price > 0),
  ADD COLUMN stop_loss_price BIGINT CHECK (stop_loss_price > 0),
  ADD COLUMN parent_id BIGINT REFERENCES orders (id),
  DROP CONSTRAINT orders_limit_fields,
  ADD CONSTRAINT orders_limit_fields CHECK (
    (type IN ('limit', 'bracket')) = (limit_price IS NOT NULL AND hold_amount IS NOT NULL AND hold_entry_id IS NOT NULL)
  ),
  ADD CONSTRAINT orders_bracket_fields CHECK (
    (type = 'bracket') = (take_profit_price IS NOT NULL AND stop_loss_price IS NOT NULL)
    AND (type <> 'bracket' OR (side = 'buy' AND stop_loss_price < limit_price AND limit_price < take_profit_price))
  ),
  ADD CONSTRAINT orders_child_fields CHECK (parent_id IS NULL OR (type IN ('limit', 'stop') AND side = 'sell')),
  DROP CONSTRAINT orders_only_pending_types_wait,
  ADD CONSTRAINT orders_only_pending_types_wait CHECK (status <> 'open' OR type IN ('limit', 'stop', 'bracket'));

CREATE INDEX orders_parent_id_idx ON orders (parent_id) WHERE parent_id IS NOT NULL;
