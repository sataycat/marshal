import { lazy, Suspense } from "react";
import { Route, Switch, Redirect, useLocation } from "wouter";
import { AppShell } from "./shell/AppShell";
import { ToastHost } from "./toast/ToastHost";
import { ROUTES } from "./routes/routes";
import { WebSocketBridge } from "./state/WebSocketBridge";
import { ConfirmProvider } from "./components/ConfirmDialog";
import { AuthGate } from "./auth/AuthGate";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { useInstalledAgentsQuery, useRepositoriesQuery } from "./api/queries";
import { RepositorySetup } from "./repositories/RepositorySetup";
import { BoardRoute } from "./routes/BoardRoute";

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
const WorkflowsRoute = lazy(() => import("./routes/WorkflowsRoute").then((m) => ({ default: m.WorkflowsRoute })));
const DiagnosticsRoute = lazy(() => import("./routes/DiagnosticsRoute").then((m) => ({ default: m.DiagnosticsRoute })));

function RouteFallback(): JSX.Element {
  return <div className="route-loading">Loading…</div>;
}

export function App(): JSX.Element {
  const repositories = useRepositoriesQuery();
  const agents = useInstalledAgentsQuery();
  const [location] = useLocation();
  if (repositories.isPending || agents.isPending) return <div className="flex min-h-svh items-center justify-center bg-bg text-muted">Loading Marshal...</div>;
  if (repositories.isError || agents.isError) return <div className="flex min-h-svh items-center justify-center bg-bg text-danger">Unable to load Marshal: {(repositories.error ?? agents.error)?.message}</div>;
  if (!agents.data.some((agent) => agent.status === "installed") && location !== ROUTES.agents) return <RepositorySetup />;
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
              <Route path={ROUTES.workflows}><WorkflowsRoute /></Route>
              <Route path={ROUTES.board}><BoardRoute /></Route>
              <Route path={ROUTES.diagnostics}><DiagnosticsRoute /></Route>
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
