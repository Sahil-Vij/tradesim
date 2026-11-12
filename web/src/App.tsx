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

export function App() {
  const status = useServerStatus();

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <span className="text-lg font-semibold tracking-tight">
            trade<span className="text-emerald-400">sim</span>
          </span>
          <span className="flex items-center gap-2 text-sm text-zinc-400" role="status">
            <span className={`h-2 w-2 rounded-full ${statusDot[status]}`} aria-hidden="true" />
            {statusLabel[status]}
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-16">
        <h1 className="max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">
          Practice trading with real prices and fake money.
        </h1>
        <p className="mt-4 max-w-xl text-lg text-zinc-400">
          Start with ₹10,00,000 and $10,000. Trade stocks and crypto with market, limit, stop-loss
          and bracket orders, and see exactly how your portfolio does.
        </p>
      </main>
    </div>
  );
}
