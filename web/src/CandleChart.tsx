import {
  CandlestickSeries,
  ColorType,
  createChart,
  CrosshairMode,
  HistogramSeries,
  TickMarkType,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import { applyTick, INTERVALS, precisionFor, toBar, type ApiCandle, type Bar, type IntervalId } from "./candles.ts";
import type { LivePrice } from "./usePrices.ts";

// Canvas can't read CSS variables, so the palette from index.css is repeated here.
const C = {
  text: "#8c98b3",
  grid: "rgba(38, 50, 77, 0.55)",
  rule: "#26324d",
  gain: "#2bd38f",
  loss: "#ff5c6c",
  gainVolume: "rgba(43, 211, 143, 0.28)",
  lossVolume: "rgba(255, 92, 108, 0.28)",
  crosshair: "#f5b53f",
};

const volumeBar = (b: Bar) => ({
  time: b.time as UTCTimestamp,
  value: b.volume,
  color: b.close >= b.open ? C.gainVolume : C.lossVolume,
});
const candleBar = (b: Bar) => ({ ...b, time: b.time as UTCTimestamp });

// The chart works in UTC seconds; people read their own clock.
const local = (seconds: number, options: Intl.DateTimeFormatOptions) =>
  new Date(seconds * 1000).toLocaleString(undefined, options);
function tickLabel(seconds: number, kind: TickMarkType): string {
  if (kind === TickMarkType.Year) return local(seconds, { year: "numeric" });
  if (kind === TickMarkType.Month) return local(seconds, { month: "short" });
  if (kind === TickMarkType.DayOfMonth) return local(seconds, { day: "numeric", month: "short" });
  return local(seconds, { hour: "2-digit", minute: "2-digit", hour12: false });
}

type Status = "loading" | "ready" | "error";

export function CandleChart({ symbol, name, price }: { symbol: string; name: string; price: LivePrice | undefined }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volume = useRef<ISeriesApi<"Histogram"> | null>(null);
  const bars = useRef<Bar[]>([]);
  const [interval, setTimeframe] = useState<IntervalId>("1m");
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<Status>("loading");
  const [hover, setHover] = useState<Bar | null>(null);
  const [latest, setLatest] = useState<Bar | null>(null);

  // Create the chart once; it resizes itself with its box.
  useEffect(() => {
    const el = box.current!;
    const c = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: C.text, fontFamily: "IBM Plex Sans", attributionLogo: false },
      grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      rightPriceScale: { borderColor: C.rule, scaleMargins: { top: 0.05, bottom: 0.16 } },
      timeScale: {
        borderColor: C.rule,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 6,
        barSpacing: 12,
        tickMarkFormatter: (time: unknown, kind: TickMarkType) => tickLabel(time as number, kind),
      },
      localization: {
        timeFormatter: (time: unknown) =>
          local(time as number, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }),
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: C.crosshair, labelBackgroundColor: "#1c2740", style: 3 },
        horzLine: { color: C.crosshair, labelBackgroundColor: "#1c2740", style: 3 },
      },
    });
    candles.current = c.addSeries(CandlestickSeries, {
      upColor: C.gain,
      downColor: C.loss,
      borderVisible: false,
      wickUpColor: C.gain,
      wickDownColor: C.loss,
    });
    volume.current = c.addSeries(HistogramSeries, { priceScaleId: "volume", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    c.priceScale("volume").applyOptions({ scaleMargins: { top: 0.87, bottom: 0 } });
    c.subscribeCrosshairMove((param) => {
      const t = param.time as number | undefined;
      setHover(t === undefined ? null : (bars.current.find((b) => b.time === t) ?? null));
    });
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
    };
  }, []);

  // Load history whenever the coin or interval changes.
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setHover(null);
    api<{ candles: ApiCandle[] }>(`/api/candles?symbol=${symbol}&interval=${interval}&limit=300`)
      .then(({ candles: rows }) => {
        if (cancelled || !candles.current) return;
        const loaded = rows.map(toBar);
        bars.current = loaded;
        const precision = precisionFor(loaded.at(-1)?.close ?? 1);
        candles.current.applyOptions({ priceFormat: { type: "price", precision, minMove: 10 ** -precision } });
        candles.current.setData(loaded.map(candleBar));
        volume.current!.setData(loaded.map(volumeBar));
        // Open on the most recent candles at a readable width; older ones are a scroll away.
        chart.current!.timeScale().applyOptions({ barSpacing: 12 });
        chart.current!.timeScale().scrollToRealTime();
        setLatest(loaded.at(-1) ?? null);
        setStatus("ready");
      })
      .catch(() => !cancelled && setStatus("error"));
    return () => {
      cancelled = true;
    };
  }, [symbol, interval, attempt]);

  // Move the newest candle with each live price.
  useEffect(() => {
    if (status !== "ready" || !price || price.symbol !== symbol) return;
    const seconds = INTERVALS.find((i) => i.id === interval)!.seconds;
    const next = applyTick(bars.current.at(-1), Number(price.price) / 1e8, Date.parse(price.time), seconds);
    if (!next) return;
    if (next.time === bars.current.at(-1)!.time) bars.current[bars.current.length - 1] = next;
    else bars.current.push(next);
    candles.current!.update(candleBar(next));
    volume.current!.update(volumeBar(next));
    setLatest(next);
  }, [price, symbol, interval, status]);

  const shown = hover ?? latest;
  const change = shown && shown.open ? ((shown.close - shown.open) / shown.open) * 100 : null;
  const digits = precisionFor(shown?.close ?? 1);
  const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

  return (
    <section aria-label="Chart" className="animate-rise overflow-hidden rounded-xl border border-rule bg-slate">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4">
        <div className="flex items-baseline gap-2">
          <h2 className="text-base font-semibold">{symbol}</h2>
          <span className="text-sm text-fog">{name} in dollars</span>
          {status === "ready" && price && !price.stale && (
            <span className="ml-1 flex items-center gap-1.5 text-xs text-gain">
              <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
                <span className="absolute inset-0 animate-ping rounded-full bg-gain opacity-60" />
                <span className="relative h-1.5 w-1.5 rounded-full bg-gain" />
              </span>
              Live
            </span>
          )}
        </div>
        <div className="flex rounded-md bg-ink p-0.5 text-xs" role="group" aria-label="Candle length">
          {INTERVALS.map((i) => (
            <button
              key={i.id}
              type="button"
              aria-pressed={interval === i.id}
              onClick={() => setTimeframe(i.id)}
              className={`rounded px-2.5 py-1 transition-colors ${interval === i.id ? "bg-raised text-paper" : "text-fog hover:text-paper"}`}
            >
              {i.label}
            </button>
          ))}
        </div>
      </div>

      <dl className="flex min-h-5 flex-wrap gap-x-4 gap-y-1 px-5 pt-2 text-xs text-fog" aria-live="off">
        {shown &&
          (
            [
              ["Open", shown.open],
              ["High", shown.high],
              ["Low", shown.low],
              ["Close", shown.close],
            ] as const
          ).map(([label, v]) => (
            <div key={label} className="flex gap-1">
              <dt>{label}</dt>
              <dd className="text-paper">{fmt(v)}</dd>
            </div>
          ))}
        {change !== null && (
          <dd className={change >= 0 ? "text-gain" : "text-loss"}>
            {change >= 0 ? "+" : "−"}
            {Math.abs(change).toFixed(2)}%
          </dd>
        )}
      </dl>

      <div className="relative h-[26rem] lg:h-[30rem]">
        <div
          ref={box}
          className={`absolute inset-0 transition-[opacity,filter] duration-500 ease-out ${
            status === "ready" ? "opacity-100" : "opacity-30 blur-[1px]"
          }`}
        />
        {status === "loading" && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-fog">
            <span className="flex items-center gap-2 rounded-full bg-ink/80 px-3 py-1.5">
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-rule border-t-saffron" aria-hidden="true" />
              Loading {symbol} candles
            </span>
          </div>
        )}
        {status === "error" && (
          <div className="absolute inset-0 grid place-items-center text-sm">
            <div className="text-center">
              <p className="text-fog">Couldn't load candles from Binance.</p>
              <button
                type="button"
                onClick={() => setAttempt((n) => n + 1)}
                className="mt-3 rounded-md border border-rule px-3 py-1.5 text-paper transition-colors hover:border-saffron"
              >
                Try again
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
