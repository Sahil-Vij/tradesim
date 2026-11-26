import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, type Holding, type Order, type Wallet } from "./api.ts";
import { formatInr, formatPrice, formatUnits, formatUsd, orderTotal } from "./money.ts";
import { CandleChart } from "./CandleChart.tsx";
import { RollingNumber } from "./RollingNumber.tsx";
import { Sparkline } from "./Sparkline.tsx";
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

/** Every account starts with $10,000; profit and loss is measured from there. */
const STARTING_USD = 1_000_000n;

export function Dashboard() {
  const { prices, error } = usePrices();
  const [wallets, setWallets] = useState<Wallet[] | null>(null);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [selected, setSelected] = useState("BTC");
  const [lastFill, setLastFill] = useState<{ symbol: string; n: number } | null>(null);

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
  const usd = BigInt(wallets?.find((w) => w.asset === "USD")?.balance ?? "0");
  const inr = wallets?.find((w) => w.asset === "INR")?.balance ?? "0";
  const heldOf = (symbol: string) => BigInt(holdings.find((h) => h.asset === symbol)?.quantity ?? "0");
  const valueOf = (h: Holding) => {
    const p = priceOf(h.asset);
    return p ? orderTotal(BigInt(h.quantity), BigInt(p.price)) : null;
  };

  const coins = holdings.reduce((sum, h) => sum + (valueOf(h) ?? 0n), 0n);
  const pricesReady = holdings.every((h) => priceOf(h.asset));
  const total = usd + coins;
  const pnl = total - STARTING_USD;
  // Basis points, so the percentage stays an exact integer until it's formatted.
  const pnlBps = (pnl * 10_000n) / STARTING_USD;

  function onFilled(order: Order) {
    setLastFill((f) => ({ symbol: order.symbol, n: (f?.n ?? 0) + 1 }));
    loadAccount().catch(() => {});
  }

  return (
    <div className="space-y-6">
      <section aria-label="Balances" className="animate-rise rounded-xl border border-rule bg-slate">
        <div className="grid gap-6 p-5 sm:grid-cols-[1.4fr_1fr_1fr_1fr] sm:items-end">
          <div>
            <div className="text-sm text-fog">Portfolio value</div>
            {wallets && pricesReady ? (
              <RollingNumber value={formatUsd(total)} className="mt-1 font-condensed text-4xl font-semibold tracking-tight" />
            ) : (
              <div className="mt-2 h-9 w-44 animate-pulse rounded bg-raised" />
            )}
          </div>
          <Figure label="Since you started">
            {wallets && pricesReady ? (
              <span className={pnl > 0n ? "text-gain" : pnl < 0n ? "text-loss" : "text-fog"}>
                <RollingNumber value={`${pnl > 0n ? "+" : pnl < 0n ? "−" : ""}${formatUsd(pnl < 0n ? -pnl : pnl)}`} />
                <span className="ml-2 text-sm">
                  {pnl > 0n ? "+" : pnl < 0n ? "−" : ""}
                  {formatUnits(pnlBps < 0n ? -pnlBps : pnlBps, 2, 2)}%
                </span>
              </span>
            ) : (
              "—"
            )}
          </Figure>
          <Figure label="Cash">{wallets ? <RollingNumber value={formatUsd(usd)} /> : "—"}</Figure>
          <Figure label="Rupee wallet" hint="For stocks, coming later">
            {wallets ? formatInr(inr) : "—"}
          </Figure>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="min-w-0 space-y-6">
          <CandleChart symbol={selected} name={names[selected] ?? selected} price={priceOf(selected)} />
          <section
            aria-label="Markets"
            className="animate-rise overflow-hidden rounded-xl border border-rule bg-slate [animation-delay:80ms]"
          >
            <div className="flex items-baseline justify-between px-5 pt-4 pb-3">
              <h2 className="text-base font-semibold">Markets</h2>
              <span className="text-xs text-fog">
                {error ? <span className="text-loss">Can't load prices</span> : "Binance prices in USDT, counted as dollars"}
              </span>
            </div>
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-fog">
                <tr className="border-y border-rule">
                  <th className="px-5 py-2 font-normal">Coin</th>
                  <th className="hidden px-3 py-2 font-normal md:table-cell">Since you opened the page</th>
                  <th className="px-5 py-2 text-right font-normal">Price</th>
                  <th className="hidden w-24 px-5 py-2 text-right font-normal sm:table-cell">Updated</th>
                </tr>
              </thead>
              <tbody>
                {prices.map((p) => (
                  <PriceRow key={p.symbol} price={p} active={p.symbol === selected} onSelect={() => setSelected(p.symbol)} />
                ))}
                {prices.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-5 py-8 text-center text-fog">
                      No prices yet. Start the price worker with <code className="text-paper">npm run dev:prices</code>.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>

          <section aria-label="Holdings" className="animate-rise rounded-xl border border-rule bg-slate [animation-delay:160ms]">
            <h2 className="px-5 pt-4 pb-3 text-base font-semibold">Your coins</h2>
            {holdings.length === 0 ? (
              <p className="border-t border-rule px-5 py-8 text-sm text-fog">
                You don't own any coins yet. Pick one from Markets and buy it on the right.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-fog">
                  <tr className="border-y border-rule">
                    <th className="px-5 py-2 font-normal">Coin</th>
                    <th className="px-5 py-2 text-right font-normal">Amount</th>
                    <th className="px-5 py-2 text-right font-normal">Value now</th>
                    <th className="hidden px-5 py-2 text-right font-normal sm:table-cell">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {holdings.map((h) => {
                    const value = valueOf(h);
                    const share = value !== null && total > 0n ? (value * 1000n) / total : null;
                    const justFilled = lastFill?.symbol === h.asset;
                    return (
                      <tr
                        key={justFilled ? `${h.asset}-${lastFill!.n}` : h.asset}
                        onClick={() => setSelected(h.asset)}
                        className={`cursor-pointer border-t border-rule/70 transition-colors first:border-t-0 hover:bg-raised/60 ${
                          justFilled ? "animate-settle" : ""
                        }`}
                      >
                        <td className="px-5 py-3">
                          <span className="font-medium">{h.asset}</span>
                          <span className="ml-2 text-fog">{names[h.asset] ?? ""}</span>
                        </td>
                        <td className="px-5 py-3 text-right">{formatUnits(h.quantity, h.decimals)}</td>
                        <td className="px-5 py-3 text-right">{value !== null ? <RollingNumber value={formatUsd(value)} /> : "—"}</td>
                        <td className="hidden px-5 py-3 sm:table-cell">
                          {share !== null && (
                            <div className="ml-auto flex w-28 items-center gap-2">
                              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink">
                                <div
                                  className="h-full rounded-full bg-saffron transition-[width] duration-700"
                                  style={{ width: `${Number(share) / 10}%` }}
                                />
                              </div>
                              <span className="w-10 text-right text-xs text-fog">{formatUnits(share, 1)}%</span>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
        </div>

        <aside className="animate-rise lg:sticky lg:top-6 lg:self-start [animation-delay:120ms]">
          <TradePanel
            symbol={selected}
            name={names[selected] ?? selected}
            price={priceOf(selected)}
            cash={usd}
            held={heldOf(selected)}
            onFilled={onFilled}
          />
        </aside>
      </div>
    </div>
  );
}

function Figure({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-sm text-fog">{label}</div>
      <div className="mt-1 text-lg font-medium">{children}</div>
      {hint && <div className="text-xs text-fog/70">{hint}</div>}
    </div>
  );
}

function PriceRow({ price, active, onSelect }: { price: LivePrice; active: boolean; onSelect: () => void }) {
  const move =
    price.direction === "up"
      ? { text: "text-gain", glow: "animate-glow-gain", arrow: "▲" }
      : price.direction === "down"
        ? { text: "text-loss", glow: "animate-glow-loss", arrow: "▼" }
        : { text: "", glow: "", arrow: "" };
  return (
    <tr
      onClick={onSelect}
      className={`group cursor-pointer border-t border-rule/70 transition-colors first:border-t-0 ${
        active ? "bg-raised" : "hover:bg-raised/60"
      }`}
    >
      <td className="relative px-5 py-3">
        <span
          aria-hidden="true"
          className={`absolute inset-y-2 left-0 w-0.5 rounded-r bg-saffron transition-opacity ${active ? "opacity-100" : "opacity-0"}`}
        />
        <button type="button" onClick={onSelect} className="text-left" aria-pressed={active}>
          <span className="font-medium">{price.symbol}</span>
          <span className="ml-2 text-fog">{names[price.symbol] ?? ""}</span>
        </button>
      </td>
      <td className="hidden px-3 py-1 md:table-cell">
        <Sparkline points={price.history} />
      </td>
      <td className="px-5 py-3 text-right">
        {/* Only the highlight is keyed to replay; the number itself stays mounted so its digits roll. */}
        <span className={`relative inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 ${move.text}`}>
          {price.changes > 0 && (
            <span key={price.changes} aria-hidden="true" className={`absolute inset-0 rounded ${move.glow}`} />
          )}
          <span className="text-[0.6rem]" aria-hidden="true">
            {move.arrow}
          </span>
          <RollingNumber value={formatPrice(price.price)} />
        </span>
      </td>
      <td className="hidden px-5 py-3 text-right text-xs sm:table-cell">
        {price.stale ? (
          <span className="text-saffron">{Math.round(price.ageMs / 1000)}s old</span>
        ) : (
          <span className="text-fog">{(price.ageMs / 1000).toFixed(1)}s ago</span>
        )}
      </td>
    </tr>
  );
}
