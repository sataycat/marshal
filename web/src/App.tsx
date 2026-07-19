import { lazy, Suspense } from "react";
import { Route, Switch, Redirect } from "wouter";
import { AppShell } from "./shell/AppShell";
import { ToastHost } from "./toast/ToastHost";
import { ROUTES } from "./routes/routes";
import { WebSocketBridge } from "./state/WebSocketBridge";
import { ConfirmProvider } from "./components/ConfirmDialog";
import { AuthGate } from "./auth/AuthGate";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { useInstalledAgentsQuery, useRepositoriesQuery } from "./api/queries";
import { BoardRoute } from "./routes/BoardRoute";
import { ThemeProvider } from "./theme";

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
  if (repositories.isPending || agents.isPending) return <div className="flex min-h-svh items-center justify-center bg-bg text-muted">Loading Marshal...</div>;
  if (repositories.isError || agents.isError) return <div className="flex min-h-svh items-center justify-center bg-bg text-danger">Unable to load Marshal: {(repositories.error ?? agents.error)?.message}</div>;
  const hasReadyAgent = agents.data.some((agent) => agent.status === "installed" && agent.readiness_status === "ready");
  return (
    <ThemeProvider>
      <AppErrorBoundary>
      <AuthGate>
        <ConfirmProvider>
          <WebSocketBridge>
          <AppShell onboarding={!hasReadyAgent}>
          <Suspense fallback={<RouteFallback />}>
            <Switch>
              <Route path={ROUTES.home}>
                <Redirect to={hasReadyAgent ? ROUTES.chat : ROUTES.agents} />
              </Route>
              <Route path={ROUTES.chat}>
                {hasReadyAgent ? <ChatRoute /> : <Redirect to={ROUTES.agents} />}
              </Route>
              <Route path={ROUTES.agents}>
                <AgentsRoute />
              </Route>
              <Route path={ROUTES.workflows}>{hasReadyAgent ? <WorkflowsRoute /> : <Redirect to={ROUTES.agents} />}</Route>
              <Route path={ROUTES.board}>{hasReadyAgent ? <BoardRoute /> : <Redirect to={ROUTES.agents} />}</Route>
              <Route path={ROUTES.diagnostics}>{hasReadyAgent ? <DiagnosticsRoute /> : <Redirect to={ROUTES.agents} />}</Route>
              <Route path="/chat/:threadId">
                {(params) => hasReadyAgent ? <ChatThreadRoute threadId={params.threadId ?? ""} /> : <Redirect to={ROUTES.agents} />}
              </Route>
              <Route>{hasReadyAgent ? <NotFoundRoute /> : <Redirect to={ROUTES.agents} />}</Route>
            </Switch>
          </Suspense>
          </AppShell>
          <ToastHost />
          </WebSocketBridge>
        </ConfirmProvider>
      </AuthGate>
      </AppErrorBoundary>
    </ThemeProvider>
  );
}
