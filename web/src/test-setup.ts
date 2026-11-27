import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// jsdom has no canvas, so the chart library is replaced with a stand-in that records calls.
vi.mock("lightweight-charts", () => {
  const series = () => ({ setData: vi.fn(), update: vi.fn(), applyOptions: vi.fn() });
  return {
    ColorType: { Solid: "solid" },
    CrosshairMode: { Normal: 0 },
    TickMarkType: { Year: 0, Month: 1, DayOfMonth: 2, Time: 3, TimeWithSeconds: 4 },
    CandlestickSeries: "Candlestick",
    HistogramSeries: "Histogram",
    createChart: vi.fn(() => ({
      addSeries: vi.fn(series),
      priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
      subscribeCrosshairMove: vi.fn(),
      timeScale: vi.fn(() => ({ applyOptions: vi.fn(), scrollToRealTime: vi.fn() })),
      remove: vi.fn(),
    })),
  };
});
