import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, ApiError, type Order } from "./api.ts";
import type { LivePrice } from "./usePrices.ts";
import { formatPrice, formatUnits, formatUsd, maxQuantity, orderTotal, parseAmount } from "./money.ts";

const messages: Record<string, string> = {
  insufficient_funds: "Not enough dollars for this order.",
  insufficient_holdings: "You don't hold that many coins.",
  order_too_small: "The smallest order is $1.",
  price_unavailable: "The price is out of date right now. Try again in a moment.",
};

type Props = {
  symbol: string;
  price: LivePrice | undefined;
  cash: bigint;
  held: bigint;
  onFilled: (order: Order) => void;
};

export function TradePanel({ symbol, price, cash, held, onFilled }: Props) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
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
        text: `${verb} ${formatUnits(order.quantity, 8)} ${order.symbol} at ${formatPrice(order.price)} for ${formatUsd(order.total)}.`,
      });
      setAmount("");
      onFilled(order);
    } catch (err) {
      const text = err instanceof ApiError ? (messages[err.code] ?? "The order didn't go through.") : null;
      // A network error might mean the order did go through. Keep the key so trying again is safe.
      setMessage({ kind: "error", text: text ?? "Lost connection. Press the button again; it won't order twice." });
    } finally {
      setBusy(false);
    }
  }

  const tab = (s: "buy" | "sell") =>
    `flex-1 rounded py-1.5 text-sm font-medium ${
      side === s ? (s === "buy" ? "bg-emerald-500 text-zinc-950" : "bg-rose-500 text-zinc-950") : "text-zinc-400"
    }`;

  return (
    <form onSubmit={submit} className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5" aria-label="Trade">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">{symbol}</h2>
        <span className="font-mono text-sm text-zinc-400">{unitPrice ? formatPrice(unitPrice) : "—"}</span>
      </div>
      <div className="mb-4 flex rounded-md bg-zinc-800 p-1">
        <button type="button" className={tab("buy")} onClick={() => setSide("buy")} aria-pressed={side === "buy"}>
          Buy
        </button>
        <button type="button" className={tab("sell")} onClick={() => setSide("sell")} aria-pressed={side === "sell"}>
          Sell
        </button>
      </div>
      <label className="block text-sm text-zinc-400">
        Amount ({symbol})
        <input
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-zinc-100 outline-none focus:border-emerald-500"
        />
      </label>
      <div className="mt-2 flex gap-2">
        {[25n, 50n, 100n].map((f) => (
          <button
            key={String(f)}
            type="button"
            onClick={() => fill(f)}
            className="flex-1 rounded border border-zinc-700 py-1 text-xs text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
          >
            {f === 100n ? "Max" : `${f}%`}
          </button>
        ))}
      </div>
      <dl className="mt-4 space-y-1 text-sm">
        <div className="flex justify-between text-zinc-400">
          <dt>{side === "buy" ? "Available" : "You hold"}</dt>
          <dd className="font-mono">{side === "buy" ? formatUsd(cash) : `${formatUnits(held, 8)} ${symbol}`}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-zinc-400">{side === "buy" ? "Estimated cost" : "Estimated proceeds"}</dt>
          <dd className="font-mono" data-testid="estimate">
            {total !== null ? formatUsd(total) : "—"}
          </dd>
        </div>
      </dl>
      {problem && <p className="mt-3 text-sm text-amber-400">{problem}</p>}
      {message && (
        <p role={message.kind === "error" ? "alert" : "status"} className={`mt-3 text-sm ${message.kind === "ok" ? "text-emerald-400" : "text-rose-400"}`}>
          {message.text}
        </p>
      )}
      <button
        type="submit"
        disabled={busy || !quantity || problem !== null}
        className={`mt-4 w-full rounded-md py-2 font-medium text-zinc-950 disabled:opacity-40 ${
          side === "buy" ? "bg-emerald-500 hover:bg-emerald-400" : "bg-rose-500 hover:bg-rose-400"
        }`}
      >
        {busy ? "Placing order…" : `${side === "buy" ? "Buy" : "Sell"} ${symbol} at market`}
      </button>
      <p className="mt-2 text-xs text-zinc-500">Fills at the last price. No fees or slippage.</p>
    </form>
  );
}
