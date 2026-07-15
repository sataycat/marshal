import { lazy, Suspense } from "react";
import { Route, Switch, Redirect } from "wouter";
import { BoardProvider } from "./board/BoardContext";
import { AppShell } from "./shell/AppShell";
import { ToastHost } from "./toast/ToastHost";
import { ROUTES } from "./routes/routes";

const BoardRoute = lazy(() =>
  import("./routes/BoardRoute").then((m) => ({ default: m.BoardRoute })),
);
const ChatRoute = lazy(() =>
  import("./routes/ChatRoute").then((m) => ({ default: m.ChatRoute })),
);
const ChatThreadRoute = lazy(() =>
  import("./routes/ChatThreadRoute").then((m) => ({ default: m.ChatThreadRoute })),
);
const NotFoundRoute = lazy(() =>
  import("./routes/NotFoundRoute").then((m) => ({ default: m.NotFoundRoute })),
);

function RouteFallback(): JSX.Element {
  return <div className="route-loading">Loading…</div>;
}

export function App(): JSX.Element {
  return (
    <BoardProvider>
      <AppShell>
        <Suspense fallback={<RouteFallback />}>
          <Switch>
            <Route path={ROUTES.home}>
              <Redirect to={ROUTES.board} />
            </Route>
            <Route path={ROUTES.board}>
              <BoardRoute />
            </Route>
            <Route path={ROUTES.chat}>
              <ChatRoute />
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
    </BoardProvider>
  );
}
