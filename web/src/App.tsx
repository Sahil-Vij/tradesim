import { useEffect, useState } from "react";
import { api, refresh, setAccessToken } from "./api.ts";
import { AuthForm } from "./AuthForm.tsx";
import { Dashboard } from "./Dashboard.tsx";
import { useServerStatus, type ServerStatus } from "./useServerStatus.ts";

const statusLabel: Record<ServerStatus, string> = {
  checking: "Checking server",
  up: "Server online",
  down: "Server offline",
};

const statusDot: Record<ServerStatus, string> = {
  checking: "bg-zinc-500",
  up: "bg-emerald-400",
  down: "bg-rose-500",
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
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <span className="text-lg font-semibold tracking-tight">
            trade<span className="text-emerald-400">sim</span>
          </span>
          <div className="flex items-center gap-4 text-sm">
            <span className="flex items-center gap-2 text-zinc-400" role="status">
              <span className={`h-2 w-2 rounded-full ${statusDot[status]}`} aria-hidden="true" />
              {statusLabel[status]}
            </span>
            {session.state === "in" && (
              <>
                <span className="hidden text-zinc-400 sm:inline">{session.email}</span>
                <button onClick={signOut} className="text-zinc-400 hover:text-zinc-100">
                  Sign out
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">
        {session.state === "in" && <Dashboard />}
        {session.state === "out" && (
          <div className="grid items-center gap-10 py-8 lg:grid-cols-[1fr_auto]">
            <div>
              <h1 className="max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">
                Practice trading with real prices and fake money.
              </h1>
              <p className="mt-4 max-w-xl text-lg text-zinc-400">
                Start with ₹10,00,000 and $10,000. Trade crypto at live Binance prices, and see exactly how
                your portfolio does. Every rupee and coin is tracked in a double-entry ledger.
              </p>
            </div>
            <AuthForm onSignedIn={(email) => setSession({ state: "in", email })} />
          </div>
        )}
      </main>
    </div>
  );
}
