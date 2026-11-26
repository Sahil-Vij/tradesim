import { useState, type FormEvent } from "react";
import { api, ApiError, setAccessToken } from "./api.ts";

const messages: Record<string, string> = {
  invalid_email: "That doesn't look like an email address.",
  invalid_password: "Use a password of 8 to 128 characters.",
  email_taken: "There's already an account with that email. Log in instead.",
  invalid_credentials: "Wrong email or password.",
};

export function AuthForm({ onSignedIn }: { onSignedIn: (email: string) => void }) {
  const [mode, setMode] = useState<"signup" | "login">("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = await api<{ accessToken: string; user: { email: string } }>(`/api/auth/${mode}`, {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      setAccessToken(body.accessToken);
      onSignedIn(body.user.email);
    } catch (err) {
      setError(err instanceof ApiError ? (messages[err.code] ?? "Something went wrong.") : "Can't reach the server.");
    } finally {
      setBusy(false);
    }
  }

  const input =
    "w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-100 outline-none focus:border-emerald-500";

  return (
    <form onSubmit={submit} className="w-full rounded-xl border border-zinc-800 bg-zinc-900/60 p-6 lg:w-96">
      <div className="mb-5 flex rounded-md bg-zinc-800 p-1 text-sm" role="tablist">
        {(["signup", "login"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => {
              setMode(m);
              setError(null);
            }}
            className={`flex-1 rounded py-1.5 ${mode === m ? "bg-zinc-950 text-zinc-100" : "text-zinc-400"}`}
          >
            {m === "signup" ? "Create account" : "Log in"}
          </button>
        ))}
      </div>
      <label className="mb-3 block text-sm text-zinc-400">
        Email
        <input
          className={`${input} mt-1`}
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </label>
      <label className="mb-5 block text-sm text-zinc-400">
        Password
        <input
          className={`${input} mt-1`}
          type="password"
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </label>
      {error && (
        <p role="alert" className="mb-4 text-sm text-rose-400">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-md bg-emerald-500 py-2 font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-60"
      >
        {busy ? "One moment…" : mode === "signup" ? "Start with ₹10,00,000 and $10,000" : "Log in"}
      </button>
    </form>
  );
}
