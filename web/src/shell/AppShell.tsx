import { Link, useLocation } from "wouter";
import { NAV_ITEMS, ROUTES, type StaticPath } from "../routes/routes";
import { useBoardContext } from "../board/BoardContext";
import { useCallback } from "react";

export function AppShell({ children }: { children: React.ReactNode }): JSX.Element {
  const { status } = useBoardContext();
  return (
    <div className="app-shell">
      <header className="app-shell-header">
        <div className="app-shell-brand">
          <Link href={ROUTES.home} className="app-shell-brand-link">
            Marshal
          </Link>
        </div>
        <nav className="app-shell-nav" aria-label="Primary">
          {NAV_ITEMS.map((item) => (
            <PrefetchNavLink key={item.path} path={item.path} label={item.label} />
          ))}
        </nav>
        <div className="app-shell-status">
          <span className={`ws-status ws-${status}`} title={`WebSocket: ${status}`}>
            {status}
          </span>
        </div>
      </header>
      <main className="app-shell-main">{children}</main>
    </div>
  );
}

interface PrefetchNavLinkProps {
  path: StaticPath;
  label: string;
}

function PrefetchNavLink({ path, label }: PrefetchNavLinkProps): JSX.Element {
  const [location] = useLocation();
  const isActive =
    location === path || (path === ROUTES.board && location === ROUTES.home);
  const onEnter = useCallback(() => {
    if (path === ROUTES.board) {
      void import("../routes/BoardRoute");
    } else if (path === ROUTES.chat) {
      void import("../routes/ChatRoute");
    }
  }, [path]);
  return (
    <Link
      href={path}
      className={isActive ? "app-shell-nav-link is-active" : "app-shell-nav-link"}
      onMouseEnter={onEnter}
      onFocus={onEnter}
    >
      {label}
    </Link>
  );
}
