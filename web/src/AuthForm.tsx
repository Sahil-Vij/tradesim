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
    "w-full rounded-md border border-rule bg-ink px-3 py-2.5 text-paper outline-none transition-colors placeholder:text-fog/60 focus:border-saffron";

  return (
    <form onSubmit={submit} className="w-full rounded-xl border border-rule bg-slate p-6 shadow-2xl shadow-black/30">
      <div className="relative mb-6 grid grid-cols-2 rounded-md bg-ink p-1 text-sm" role="tablist">
        <span
          aria-hidden="true"
          className={`absolute inset-y-1 left-1 w-[calc(50%-4px)] rounded bg-raised transition-transform duration-300 ease-out ${
            mode === "login" ? "translate-x-full" : ""
          }`}
        />
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
            className={`relative rounded py-1.5 transition-colors ${mode === m ? "text-paper" : "text-fog hover:text-paper"}`}
          >
            {m === "signup" ? "Create account" : "Log in"}
          </button>
        ))}
      </div>
      <label className="mb-3 block text-sm text-fog">
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
      <label className="mb-5 block text-sm text-fog">
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
      {mode === "signup" && <p className="-mt-2 mb-5 text-xs text-fog">At least 8 characters.</p>}
      {error && (
        <p role="alert" className="mb-4 rounded-md bg-loss/10 px-3 py-2 text-sm text-loss">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-md bg-saffron py-2.5 font-semibold text-ink transition-[filter,transform] hover:brightness-110 active:scale-[0.99] disabled:opacity-60"
      >
        {busy ? "One moment…" : mode === "signup" ? "Create account" : "Log in"}
      </button>
    </form>
  );
}
