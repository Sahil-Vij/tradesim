import { useEffect, useState } from "react";
import { api, refresh, setAccessToken } from "./api.ts";
import { AuthForm } from "./AuthForm.tsx";
import { Dashboard } from "./Dashboard.tsx";
import { formatPrice } from "./money.ts";
import { RollingNumber } from "./RollingNumber.tsx";
import { usePrices } from "./usePrices.ts";
import { useServerStatus, type ServerStatus } from "./useServerStatus.ts";

const statusLabel: Record<ServerStatus, string> = {
  checking: "Checking server",
  up: "Server online",
  down: "Server offline",
};

const statusDot: Record<ServerStatus, string> = {
  checking: "bg-fog",
  up: "bg-gain",
  down: "bg-loss",
};

type Session = { state: "loading" } | { state: "out" } | { state: "in"; email: string };

export function App() {
  const status = useServerStatus();
  const [session, setSession] = useState<Session>({ state: "loading" });

  // A reload loses the in-memory access token; the refresh cookie gets a new one.
  useEffect(() => {
    (async () => {
      if (!(await refresh())) return setSession({ state: "out" });
      try {
        const me = await api<{ email: string }>("/api/me");
        setSession({ state: "in", email: me.email });
      } catch {
        setSession({ state: "out" });
      }
    })();
  }, []);

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    setAccessToken(null);
    setSession({ state: "out" });
  }

  return (
    <div className="min-h-screen bg-ink font-sans text-paper">
      <header className="border-b border-rule">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <Logo />
          <div className="flex items-center gap-5 text-sm">
            <span className="flex items-center gap-2 text-fog" role="status">
              <span className="relative flex h-2 w-2" aria-hidden="true">
                {status === "up" && <span className="absolute inset-0 animate-ping rounded-full bg-gain opacity-50" />}
                <span className={`relative h-2 w-2 rounded-full ${statusDot[status]}`} />
              </span>
              {statusLabel[status]}
            </span>
            {session.state === "in" && (
              <>
                <span className="hidden text-fog sm:inline">{session.email}</span>
                <button onClick={signOut} className="rounded text-fog transition-colors hover:text-paper">
                  Sign out
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">
        {session.state === "in" && <Dashboard />}
        {session.state === "out" && <Landing onSignedIn={(email) => setSession({ state: "in", email })} />}
      </main>
    </div>
  );
}

function Logo() {
  return (
    <span className="flex items-center gap-2 text-lg font-semibold tracking-tight">
      <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="7" fill="var(--color-raised)" />
        <path d="M7 21l6-7 5 4 7-9" fill="none" stroke="var(--color-saffron)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      tradesim
    </span>
  );
}

function Landing({ onSignedIn }: { onSignedIn: (email: string) => void }) {
  const { prices } = usePrices();
  return (
    <div className="grid items-start gap-12 py-6 lg:grid-cols-[1fr_24rem] lg:py-14">
      <div>
        <h1 className="animate-rise max-w-xl font-condensed text-5xl leading-[1.05] font-semibold tracking-tight sm:text-6xl">
          Practice trading with real prices and fake money.
        </h1>
        <p className="animate-rise mt-5 max-w-lg text-lg leading-relaxed text-fog [animation-delay:120ms]">
          You start with ₹10,00,000 and $10,000. Buy and sell crypto at the prices below, and see how your
          portfolio would have done. Every rupee and coin is tracked in a double-entry ledger.
        </p>

        <section aria-label="Live prices" className="animate-rise mt-10 [animation-delay:240ms]">
          <p className="mb-3 text-sm text-fog">Prices right now, from Binance</p>
          <ul className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-rule bg-rule sm:grid-cols-3">
            {prices.map((p) => (
              <li key={p.symbol} className="bg-ink px-4 py-3">
                <div className="text-sm text-fog">{p.symbol}</div>
                <div
                  className={`mt-0.5 font-condensed text-xl font-medium ${
                    p.direction === "up" ? "text-gain" : p.direction === "down" ? "text-loss" : ""
                  }`}
                >
                  <RollingNumber value={formatPrice(p.price)} />
                </div>
              </li>
            ))}
            {prices.length === 0 &&
              Array.from({ length: 6 }, (_, i) => (
                <li key={i} className="bg-ink px-4 py-3">
                  <div className="h-4 w-10 animate-pulse rounded bg-raised" />
                  <div className="mt-2 h-6 w-24 animate-pulse rounded bg-raised" />
                </li>
              ))}
          </ul>
        </section>
      </div>
      <div className="animate-rise [animation-delay:180ms]">
        <AuthForm onSignedIn={onSignedIn} />
      </div>
    </div>
  );
}
