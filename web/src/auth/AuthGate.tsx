import { useEffect, useState, type ReactNode } from "react";
import { ApiError, fetchAuthStatus, login } from "../api/client";

export function AuthGate({ children }: { children: ReactNode }): JSX.Element {
  const [status, setStatus] = useState<"loading" | "login" | "ready">("loading");

  useEffect(() => {
    fetchAuthStatus()
      .then((auth) => setStatus(auth.enabled && !auth.authenticated ? "login" : "ready"))
      .catch(() => setStatus("ready"));
  }, []);

  if (status === "loading") {
    return <div className="flex min-h-svh items-center justify-center bg-bg text-sm text-muted">Checking authentication…</div>;
  }
  if (status === "login") return <LoginForm onSuccess={() => setStatus("ready")} />;
  return <>{children}</>;
}

function LoginForm({ onSuccess }: { onSuccess: () => void }): JSX.Element {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const auth = await login(password);
      if (auth.authenticated) onSuccess();
      else setError("The password was not accepted.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Unable to sign in.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-bg px-5 text-text">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border border-border bg-panel p-6 shadow-sm">
        <p className="mb-1 text-lg font-semibold">Sign in to Marshal</p>
        <p className="mb-6 text-sm text-muted">This server requires a UI password.</p>
        <label className="mb-2 block text-sm font-medium" htmlFor="marshal-password">Password</label>
        <input
          id="marshal-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="mb-4 w-full rounded-md border border-border bg-bg px-3 py-2 outline-none focus:border-primary"
          autoFocus
        />
        {error && <p className="mb-4 text-sm text-destructive">{error}</p>}
        <button type="submit" disabled={busy || password.length === 0} className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
