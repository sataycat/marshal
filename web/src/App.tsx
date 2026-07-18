import { lazy, Suspense } from "react";
import { Route, Switch, Redirect } from "wouter";
import { AppShell } from "./shell/AppShell";
import { ToastHost } from "./toast/ToastHost";
import { ROUTES } from "./routes/routes";
import { WebSocketBridge } from "./state/WebSocketBridge";
import { ConfirmProvider } from "./components/ConfirmDialog";
import { AuthGate } from "./auth/AuthGate";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { useRepositoriesQuery } from "./api/queries";
import { RepositorySetup } from "./repositories/RepositorySetup";

const ChatRoute = lazy(() =>
  import("./routes/ChatRoute").then((m) => ({ default: m.ChatRoute })),
);
const ChatThreadRoute = lazy(() =>
  import("./routes/ChatThreadRoute").then((m) => ({ default: m.ChatThreadRoute })),
);
const NotFoundRoute = lazy(() =>
  import("./routes/NotFoundRoute").then((m) => ({ default: m.NotFoundRoute })),
);
const AgentsRoute = lazy(() => import("./routes/AgentsRoute").then((m) => ({ default: m.AgentsRoute })));

function RouteFallback(): JSX.Element {
  return <div className="route-loading">Loading…</div>;
}

export function App(): JSX.Element {
  const repositories = useRepositoriesQuery();
  if (repositories.isPending) return <div className="flex min-h-svh items-center justify-center bg-bg text-muted">Loading repositories...</div>;
  if (repositories.isError) return <div className="flex min-h-svh items-center justify-center bg-bg text-danger">Unable to load repositories: {repositories.error.message}</div>;
  if (!repositories.data.selected_repository_id) return <RepositorySetup repositories={repositories.data.repositories} />;
  return (
    <AppErrorBoundary>
      <AuthGate>
        <ConfirmProvider>
          <WebSocketBridge>
          <AppShell>
          <Suspense fallback={<RouteFallback />}>
            <Switch>
              <Route path={ROUTES.home}>
                <Redirect to={ROUTES.chat} />
              </Route>
              <Route path={ROUTES.chat}>
                <ChatRoute />
              </Route>
              <Route path={ROUTES.agents}>
                <AgentsRoute />
              </Route>
              <Route path="/chat/:threadId">
                {(params) => <ChatThreadRoute threadId={params.threadId ?? ""} />}
              </Route>
              <Route>
                <NotFoundRoute />
              </Route>
            </Switch>
          </Suspense>
          </AppShell>
          <ToastHost />
          </WebSocketBridge>
        </ConfirmProvider>
      </AuthGate>
    </AppErrorBoundary>
  );
}
