import { useCallback, useEffect, useState } from "react";
import { api, type Holding, type Wallet } from "./api.ts";
import { formatInr, formatPrice, formatUnits, formatUsd, orderTotal } from "./money.ts";
import { TradePanel } from "./TradePanel.tsx";
import { usePrices, type LivePrice } from "./usePrices.ts";

const names: Record<string, string> = {
  BTC: "Bitcoin",
  ETH: "Ethereum",
  SOL: "Solana",
  BNB: "BNB",
  XRP: "XRP",
  DOGE: "Dogecoin",
};

export function Dashboard() {
  const { prices, error } = usePrices();
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [selected, setSelected] = useState("BTC");

  const loadAccount = useCallback(async () => {
    const [w, h] = await Promise.all([
      api<{ wallets: Wallet[] }>("/api/wallets"),
      api<{ holdings: Holding[] }>("/api/holdings"),
    ]);
    setWallets(w.wallets);
    setHoldings(h.holdings);
  }, []);

  useEffect(() => {
    loadAccount().catch(() => {});
  }, [loadAccount]);

  const priceOf = (symbol: string) => prices.find((p) => p.symbol === symbol);
  const usd = BigInt(wallets.find((w) => w.asset === "USD")?.balance ?? "0");
  const inr = wallets.find((w) => w.asset === "INR")?.balance ?? "0";
  const heldOf = (symbol: string) => BigInt(holdings.find((h) => h.asset === symbol)?.quantity ?? "0");

  const holdingsValue = holdings.reduce((sum, h) => {
    const p = priceOf(h.asset);
    return p ? sum + orderTotal(BigInt(h.quantity), BigInt(p.price)) : sum;
  }, 0n);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <div className="min-w-0 space-y-6">
        <section className="grid gap-4 sm:grid-cols-3" aria-label="Balances">
          <Stat label="USD cash" value={formatUsd(usd)} />
          <Stat label="Crypto value" value={formatUsd(holdingsValue)} />
          <Stat label="INR cash" value={formatInr(inr)} hint="Stocks arrive later" />
        </section>

        <section className="overflow-hidden rounded-xl border border-zinc-800" aria-label="Markets">
          <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
            <h2 className="font-semibold">Markets</h2>
            <span className="text-xs text-zinc-500">
              {error ? <span className="text-rose-400">Prices unavailable</span> : "Live from Binance · USDT as USD"}
            </span>
          </div>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-zinc-500">
              <tr>
                <th className="px-4 py-2 font-normal">Coin</th>
                <th className="px-4 py-2 text-right font-normal">Price</th>
                <th className="hidden px-4 py-2 text-right font-normal sm:table-cell">Updated</th>
              </tr>
            </thead>
            <tbody>
              {prices.map((p) => (
                <PriceRow key={p.symbol} price={p} active={p.symbol === selected} onSelect={() => setSelected(p.symbol)} />
              ))}
              {prices.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-6 text-center text-zinc-500">
                    Waiting for prices. Is the price worker running? (npm run dev:prices)
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        <section className="rounded-xl border border-zinc-800" aria-label="Holdings">
          <h2 className="border-b border-zinc-800 px-4 py-3 font-semibold">Your coins</h2>
          {holdings.length === 0 ? (
            <p className="px-4 py-6 text-sm text-zinc-500">Nothing yet. Pick a coin and buy some.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-zinc-500">
                <tr>
                  <th className="px-4 py-2 font-normal">Coin</th>
                  <th className="px-4 py-2 text-right font-normal">Amount</th>
                  <th className="px-4 py-2 text-right font-normal">Value</th>
                </tr>
              </thead>
              <tbody>
                {holdings.map((h) => {
                  const p = priceOf(h.asset);
                  return (
                    <tr key={h.asset} className="border-t border-zinc-800/70">
                      <td className="px-4 py-2.5 font-medium">{h.asset}</td>
                      <td className="px-4 py-2.5 text-right font-mono">{formatUnits(h.quantity, h.decimals)}</td>
                      <td className="px-4 py-2.5 text-right font-mono">
                        {p ? formatUsd(orderTotal(BigInt(h.quantity), BigInt(p.price))) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <aside className="lg:sticky lg:top-6 lg:self-start">
        <TradePanel
          symbol={selected}
          price={priceOf(selected)}
          cash={usd}
          held={heldOf(selected)}
          onFilled={() => loadAccount().catch(() => {})}
        />
      </aside>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 font-mono text-xl">{value}</div>
      {hint && <div className="mt-1 text-xs text-zinc-600">{hint}</div>}
    </div>
  );
}

function PriceRow({ price, active, onSelect }: { price: LivePrice; active: boolean; onSelect: () => void }) {
  const color = price.direction === "up" ? "text-emerald-400" : price.direction === "down" ? "text-rose-400" : "";
  return (
    <tr
      onClick={onSelect}
      className={`cursor-pointer border-t border-zinc-800/70 hover:bg-zinc-900 ${active ? "bg-zinc-900" : ""}`}
    >
      <td className="px-4 py-2.5">
        <button type="button" onClick={onSelect} className="text-left" aria-pressed={active}>
          <span className="font-medium">{price.symbol}</span>
          <span className="ml-2 text-zinc-500">{names[price.symbol] ?? ""}</span>
        </button>
      </td>
      <td className={`px-4 py-2.5 text-right font-mono transition-colors ${color}`}>{formatPrice(price.price)}</td>
      <td className="hidden px-4 py-2.5 text-right text-xs sm:table-cell">
        {price.stale ? (
          <span className="text-amber-400">stale · {Math.round(price.ageMs / 1000)}s</span>
        ) : (
          <span className="text-zinc-500">{(price.ageMs / 1000).toFixed(1)}s ago</span>
        )}
      </td>
    </tr>
  );
}
