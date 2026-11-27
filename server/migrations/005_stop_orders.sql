-- Stop-loss orders. See docs/design.md, "Orders".
--
-- A stop order is a sell that waits, with its coins on hold like a limit sell, until the price
-- falls to stop_price, then sells at the price of that tick. Only sells: a stop buy fills at an
-- unknown price, so there's no way to know how much cash to hold for it.

ALTER TABLE orders
  DROP CONSTRAINT orders_type_check,
  ADD CONSTRAINT orders_type_check CHECK (type IN ('market', 'limit', 'stop')),
  -- 10^-8 of the quote currency per coin, like limit_price.
  ADD COLUMN stop_price BIGINT CHECK (stop_price > 0),
  ADD CONSTRAINT orders_stop_fields CHECK (
    (type = 'stop') = (stop_price IS NOT NULL)
    AND (type <> 'stop' OR (side = 'sell' AND hold_amount IS NOT NULL AND hold_entry_id IS NOT NULL))
  ),
  DROP CONSTRAINT orders_only_limit_orders_wait,
  ADD CONSTRAINT orders_only_pending_types_wait CHECK (status <> 'open' OR type IN ('limit', 'stop'));

CREATE INDEX orders_open_stops_idx ON orders (symbol, stop_price) WHERE status = 'open' AND type = 'stop';
