import { useEffect, useState, type ReactNode } from "react";
import { ApiError, fetchAuthStatus, login } from "../api/client";
import { MarshalMark } from "../components/MarshalMark";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";

export function AuthGate({ children }: { children: ReactNode }): JSX.Element {
  const [status, setStatus] = useState<"loading" | "login" | "ready">("loading");

  useEffect(() => {
    fetchAuthStatus()
      .then((auth) => setStatus(auth.enabled && !auth.authenticated ? "login" : "ready"))
      .catch(() => setStatus("ready"));
  }, []);

  if (status === "loading") {
    return <div className="flex min-h-svh items-center justify-center bg-bg text-sm text-muted-foreground">Checking authentication…</div>;
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
      <form onSubmit={submit} className="w-full max-w-sm">
        <div className="flex flex-col items-center text-center">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
            <MarshalMark className="size-6" />
          </span>
          <h1 className="mt-4 text-xl font-semibold tracking-tight">Sign in to Marshal</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">This server requires a UI password.</p>
        </div>
        <div className="mt-6 rounded-xl border border-border bg-panel p-5 shadow-sm">
          <label className="mb-1.5 block text-sm font-medium" htmlFor="marshal-password">Password</label>
          <Input
            id="marshal-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoFocus
          />
          {error && <p className="mt-3 rounded-lg border border-error-border bg-error-bg px-3 py-2 text-sm text-error">{error}</p>}
          <Button type="submit" className="mt-4 w-full" disabled={busy || password.length === 0}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </div>
      </form>
    </main>
  );
}
