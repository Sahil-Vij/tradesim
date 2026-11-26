import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { App } from "./App.tsx";
import { setAccessToken } from "./api.ts";

type Handler = (init: RequestInit | undefined) => Response | Promise<Response>;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** A fake server: each route answers with a handler; anything else is a 404. Records requests. */
function fakeServer(routes: Record<string, Handler>) {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    const handler = routes[`${init?.method ?? "GET"} ${path}`];
    return handler ? handler(init) : json({ error: "not_found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

const price = (symbol: string, value: string) => ({
  symbol,
  quote: "USD",
  price: value,
  decimals: 8,
  time: new Date().toISOString(),
  ageMs: 800,
  stale: false,
});

const signedOut = {
  "GET /api/health": () => json({ status: "ok" }),
  "POST /api/auth/refresh": () => json({ error: "invalid_refresh_token" }, 401),
};

test("shows the server as online when the health check passes", async () => {
  fakeServer(signedOut);
  render(<App />);
  expect(await screen.findByText("Server online")).toBeInTheDocument();
});

test("shows the server as offline when the health check fails", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
  render(<App />);
  expect(await screen.findByText("Server offline")).toBeInTheDocument();
});

test("signed out, it offers sign-up and explains what went wrong", async () => {
  fakeServer({ ...signedOut, "POST /api/auth/signup": () => json({ error: "email_taken" }, 409) });
  render(<App />);
  fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "a@example.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "long enough" } });
  fireEvent.click(screen.getByRole("button", { name: "Create account" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("already an account");
});

function signedInServer(extra: Record<string, Handler> = {}) {
  let usd = "1000000";
  let holdings: unknown[] = [];
  const calls = fakeServer({
    ...signedOut,
    "POST /api/auth/refresh": () => json({ accessToken: "token" }),
    "GET /api/me": () => json({ id: "1", email: "me@example.com" }),
    "GET /api/prices": () => json({ prices: [price("BTC", "6000000000000"), price("DOGE", "5676000")] }),
    "GET /api/wallets": () =>
      json({ wallets: [{ asset: "INR", balance: "100000000", decimals: 2 }, { asset: "USD", balance: usd, decimals: 2 }] }),
    "GET /api/holdings": () => json({ holdings }),
    "POST /api/orders": () => {
      usd = "700000";
      holdings = [{ asset: "BTC", quantity: "5000000", decimals: 8 }];
      return json(
        {
          order: {
            id: "9",
            symbol: "BTC",
            side: "buy",
            quantity: "5000000",
            price: "6000000000000",
            total: "300000",
            currency: "USD",
            createdAt: new Date().toISOString(),
          },
        },
        201,
      );
    },
    ...extra,
  });
  return calls;
}

test("a reload keeps you signed in and shows balances and live prices", async () => {
  signedInServer();
  render(<App />);
  expect(await screen.findByText("me@example.com")).toBeInTheDocument();
  const balances = screen.getByRole("region", { name: "Balances" });
  // Portfolio value and cash are both $10,000 before any trade.
  expect(await within(balances).findAllByText("$10,000.00")).toHaveLength(2);
  expect(within(balances).getByText("Since you started")).toBeInTheDocument();
  expect(within(balances).getByText("₹10,00,000.00")).toBeInTheDocument();
  const markets = screen.getByRole("region", { name: "Markets" });
  expect(await within(markets).findByText("$60,000.00")).toBeInTheDocument();
  expect(within(markets).getByText("$0.05676")).toBeInTheDocument();
});

test("buying shows the cost first, sends an idempotency key, then updates the wallet", async () => {
  const calls = signedInServer();
  render(<App />);
  const trade = await screen.findByRole("form", { name: "Trade" });
  await within(trade).findByText("$60,000.00");
  fireEvent.change(within(trade).getByLabelText(/Amount/), { target: { value: "0.05" } });
  expect(within(trade).getByTestId("estimate")).toHaveTextContent("$3,000.00");

  fireEvent.click(within(trade).getByRole("button", { name: "Buy BTC at market" }));
  expect(await within(trade).findByRole("status")).toHaveTextContent("Bought 0.05 BTC at $60,000.00 for $3,000.00");

  const sent = calls.find((c) => c.path === "/api/orders")!;
  expect(JSON.parse(String(sent.init!.body))).toEqual({ symbol: "BTC", side: "buy", quantity: "5000000" });
  expect(new Headers(sent.init!.headers).get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
  expect(await within(screen.getByRole("region", { name: "Balances" })).findByText("$7,000.00")).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Holdings" })).toHaveTextContent("0.05");
});

test("after a lost connection, pressing again reuses the same key so it can't order twice", async () => {
  let attempts = 0;
  const calls = signedInServer({
    "POST /api/orders": () => {
      attempts++;
      throw new TypeError("Failed to fetch");
    },
  });
  render(<App />);
  const trade = await screen.findByRole("form", { name: "Trade" });
  await within(trade).findByText("$60,000.00");
  fireEvent.change(within(trade).getByLabelText(/Amount/), { target: { value: "0.05" } });
  const button = within(trade).getByRole("button", { name: "Buy BTC at market" });
  fireEvent.click(button);
  expect(await within(trade).findByRole("alert")).toHaveTextContent("it won't order twice");
  fireEvent.click(button);
  await waitFor(() => expect(attempts).toBe(2));

  const keys = calls
    .filter((c) => c.path === "/api/orders")
    .map((c) => new Headers(c.init!.headers).get("idempotency-key"));
  expect(keys[0]).toBe(keys[1]);
});

test("refuses an order the wallet can't cover before sending it", async () => {
  const calls = signedInServer();
  render(<App />);
  const trade = await screen.findByRole("form", { name: "Trade" });
  await within(trade).findByText("$60,000.00");
  fireEvent.change(within(trade).getByLabelText(/Amount/), { target: { value: "1" } }); // $60,000
  expect(within(trade).getByText("Not enough dollars.")).toBeInTheDocument();
  expect(within(trade).getByRole("button", { name: "Buy BTC at market" })).toBeDisabled();
  expect(calls.some((c) => c.path === "/api/orders")).toBe(false);
});

test("an expired access token is refreshed once and the request retried", async () => {
  let walletCalls = 0;
  const calls = signedInServer({
    "GET /api/wallets": () =>
      ++walletCalls === 1
        ? json({ error: "unauthorized" }, 401)
        : json({ wallets: [{ asset: "USD", balance: "1000000", decimals: 2 }] }),
  });
  render(<App />);
  expect(await within(await screen.findByRole("region", { name: "Balances" })).findAllByText("$10,000.00")).toHaveLength(2);
  expect(calls.filter((c) => c.path === "/api/auth/refresh").length).toBe(2); // page load, then the 401
  setAccessToken(null);
});

test("profit and loss is measured from the $10,000 start, at live prices", async () => {
  signedInServer({
    "GET /api/wallets": () => json({ wallets: [{ asset: "USD", balance: "700000", decimals: 2 }] }),
    "GET /api/holdings": () => json({ holdings: [{ asset: "BTC", quantity: "5000000", decimals: 8 }] }),
    "GET /api/prices": () => json({ prices: [price("BTC", "6100000000000")] }), // BTC up to $61,000
  });
  render(<App />);
  const balances = await screen.findByRole("region", { name: "Balances" });
  // $7,000 cash + 0.05 BTC × $61,000 = $10,050.
  expect(await within(balances).findByText("$10,050.00")).toBeInTheDocument();
  expect(within(balances).getByText("+$50.00")).toBeInTheDocument();
  expect(balances).toHaveTextContent("+0.50%");
});
