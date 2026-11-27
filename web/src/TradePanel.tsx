import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, ApiError, type Order } from "./api.ts";
import type { LivePrice } from "./usePrices.ts";
import { formatPrice, formatUnits, formatUsd, maxQuantity, orderTotal, parseAmount } from "./money.ts";
import { RollingNumber } from "./RollingNumber.tsx";

const messages: Record<string, string> = {
  insufficient_funds: "Not enough dollars for this order.",
  insufficient_holdings: "You don't hold that many coins.",
  order_too_small: "The smallest order is $1.",
  price_unavailable: "The price is out of date right now. Try again in a moment.",
};

type Props = {
  symbol: string;
  name: string;
  price: LivePrice | undefined;
  cash: bigint;
  held: bigint;
  onFilled: (order: Order) => void;
};

export function TradePanel({ symbol, name, price, cash, held, onFilled }: Props) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string; n: number } | null>(null);
  // One key per order the person means to place. Clicking twice, or retrying after a network
  // error, sends the same key, so the server places it once. A new order gets a new key.
  const [key, setKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    setAmount("");
    setMessage(null);
  }, [symbol]);
  useEffect(() => setKey(crypto.randomUUID()), [symbol, side, amount]);

  const quantity = parseAmount(amount, 8);
  const unitPrice = price ? BigInt(price.price) : null;
  const total = quantity && unitPrice ? orderTotal(quantity, unitPrice) : null;

  const problem = useMemo(() => {
    if (!amount) return null;
    if (quantity === null || quantity === 0n) return "Enter an amount, like 0.05.";
    if (!unitPrice || price?.stale) return "Waiting for a live price.";
    if (total! < 100n) return "The smallest order is $1.";
    if (side === "buy" && total! > cash) return "Not enough dollars.";
    if (side === "sell" && quantity > held) return `You hold ${formatUnits(held, 8)} ${symbol}.`;
    return null;
  }, [amount, quantity, unitPrice, price?.stale, total, side, cash, held, symbol]);

  function fill(fraction: bigint) {
    if (side === "buy") {
      if (!unitPrice) return;
      setAmount(formatUnits((maxQuantity(cash, unitPrice) * fraction) / 100n, 8).replaceAll(",", ""));
    } else {
      setAmount(formatUnits((held * fraction) / 100n, 8).replaceAll(",", ""));
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!quantity || problem) return;
    setBusy(true);
    setMessage(null);
    try {
      const { order } = await api<{ order: Order }>("/api/orders", {
        method: "POST",
        headers: { "idempotency-key": key },
        body: JSON.stringify({ symbol, side, quantity: String(quantity) }),
      });
      const verb = order.side === "buy" ? "Bought" : "Sold";
      setMessage({
        kind: "ok",
        n: Date.now(),
        text: `${verb} ${formatUnits(order.quantity, 8)} ${order.symbol} at ${formatPrice(order.price)} for ${formatUsd(order.total)}.`,
      });
      setAmount("");
      onFilled(order);
    } catch (err) {
      const text = err instanceof ApiError ? (messages[err.code] ?? "The order didn't go through.") : null;
      // A network error might mean the order did go through. Keep the key so trying again is safe.
      setMessage({ kind: "error", n: Date.now(), text: text ?? "Lost connection. Press the button again; it won't order twice." });
    } finally {
      setBusy(false);
    }
  }

  const buying = side === "buy";

  return (
    <form onSubmit={submit} className="rounded-xl border border-rule bg-slate p-5" aria-label="Trade">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{symbol}</h2>
          <p className="text-sm text-fog">{name}</p>
        </div>
        <div className="text-right">
          <div
            className={`font-condensed text-xl font-medium ${
              price?.direction === "up" ? "text-gain" : price?.direction === "down" ? "text-loss" : ""
            }`}
          >
            {unitPrice ? <RollingNumber value={formatPrice(unitPrice)} /> : "—"}
          </div>
          {price?.stale && <p className="text-xs text-saffron">Price is out of date</p>}
        </div>
      </div>

      <div className="relative mt-5 grid grid-cols-2 rounded-md bg-ink p-1">
        <span
          aria-hidden="true"
          className={`absolute inset-y-1 left-1 w-[calc(50%-4px)] rounded transition-[transform,background-color] duration-300 ease-out ${
            buying ? "bg-gain" : "translate-x-full bg-loss"
          }`}
        />
        {(["buy", "sell"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSide(s)}
            aria-pressed={side === s}
            className={`relative rounded py-1.5 text-sm font-semibold transition-colors ${
              side === s ? "text-ink" : "text-fog hover:text-paper"
            }`}
          >
            {s === "buy" ? "Buy" : "Sell"}
          </button>
        ))}
      </div>

      <label className="mt-5 block text-sm text-fog">
        Amount of {symbol}
        <div className="mt-1.5 flex items-center rounded-md border border-rule bg-ink transition-colors focus-within:border-saffron">
          <input
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-full bg-transparent px-3 py-2.5 text-lg text-paper outline-none placeholder:text-fog/50"
          />
          <span className="pr-3 text-sm text-fog">{symbol}</span>
        </div>
      </label>
      <div className="mt-2 grid grid-cols-3 gap-2">
        {[25n, 50n, 100n].map((f) => (
          <button
            key={String(f)}
            type="button"
            onClick={() => fill(f)}
            className="rounded-md border border-rule py-1 text-xs text-fog transition-colors hover:border-fog hover:text-paper active:bg-raised"
          >
            {f === 100n ? "Max" : `${f}%`}
          </button>
        ))}
      </div>

      <dl className="mt-5 space-y-2 border-t border-rule pt-4 text-sm">
        <div className="flex justify-between text-fog">
          <dt>{buying ? "Cash available" : "You hold"}</dt>
          <dd>{buying ? <RollingNumber value={formatUsd(cash)} /> : `${formatUnits(held, 8)} ${symbol}`}</dd>
        </div>
        <div className="flex items-baseline justify-between">
          <dt className="text-fog">{buying ? "You pay about" : "You get about"}</dt>
          <dd className="text-lg font-semibold" data-testid="estimate">
            {total !== null ? <RollingNumber value={formatUsd(total)} /> : "—"}
          </dd>
        </div>
      </dl>

      <div className="min-h-6 mt-3" aria-live="polite">
        {problem ? (
          <p className="text-sm text-saffron">{problem}</p>
        ) : message ? (
          <p
            key={message.n}
            role={message.kind === "error" ? "alert" : "status"}
            className={`animate-rise flex gap-2 rounded-md px-3 py-2 text-sm ${
              message.kind === "ok" ? "bg-gain/10 text-gain" : "bg-loss/10 text-loss"
            }`}
          >
            <span aria-hidden="true">{message.kind === "ok" ? "✓" : "!"}</span>
            {message.text}
          </p>
        ) : null}
      </div>

      <button
        type="submit"
        disabled={busy || !quantity || problem !== null}
        className={`mt-3 flex w-full items-center justify-center gap-2 rounded-md py-2.5 font-semibold text-ink transition-[filter,transform,opacity] hover:brightness-110 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:brightness-100 ${
          buying ? "bg-gain" : "bg-loss"
        }`}
      >
        {busy && <span className="h-4 w-4 animate-spin rounded-full border-2 border-ink/30 border-t-ink" aria-hidden="true" />}
        {busy ? "Placing order" : `${buying ? "Buy" : "Sell"} ${symbol} at market`}
      </button>
      <p className="mt-2 text-center text-xs text-fog">Fills at the last price, with no fees or slippage.</p>
    </form>
  );
}
