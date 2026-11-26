// Talks to the server. The access token lives only in memory (see docs/design.md, "Auth"); the
// refresh token is an HttpOnly cookie the browser sends to /api/auth by itself.

let accessToken: string | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

async function send(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
  if (init.body) headers.set("content-type", "application/json");
  return fetch(path, { ...init, headers });
}

// Several requests can hit an expired token at once; they share one refresh, because each
// refresh rotates the cookie and a second one with the old cookie would revoke the session.
let refreshing: Promise<boolean> | null = null;

export function refresh(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const res = await fetch("/api/auth/refresh", { method: "POST" });
      if (!res.ok) return false;
      setAccessToken((await res.json()).accessToken);
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** Sends a request and returns its JSON. Retries once with a fresh token if the old one expired. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res = await send(path, init);
  if (res.status === 401 && accessToken && (await refresh())) res = await send(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? "request_failed");
  return body as T;
}

export type Wallet = { asset: string; balance: string; decimals: number };
export type Holding = { asset: string; quantity: string; decimals: number };
export type Price = {
  symbol: string;
  quote: string;
  price: string;
  decimals: number;
  time: string;
  ageMs: number;
  stale: boolean;
};
export type Order = {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: string;
  price: string;
  total: string;
  currency: string;
  createdAt: string;
};
