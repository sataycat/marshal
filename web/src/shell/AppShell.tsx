import { useCallback } from "react";
import { Link, useLocation } from "wouter";
import { MessagesSquare } from "lucide-react";
import { NAV_ITEMS, ROUTES, type StaticPath } from "../routes/routes";
import { cn } from "@/lib/utils";

export function AppShell({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="@container flex min-h-svh flex-col bg-bg text-text">
      <header className="sticky top-0 z-40 flex items-center gap-4 border-b border-border bg-panel/95 px-4 py-3 backdrop-blur md:px-5">
        <div className="flex items-center gap-2">
          <Link
            href={ROUTES.home}
            className="text-lg font-semibold tracking-tight text-text transition-colors hover:text-primary"
          >
            Marshal
          </Link>
        </div>
        <nav className="hidden flex-1 items-center gap-1 md:flex" aria-label="Primary">
          {NAV_ITEMS.map((item) => (
            <PrefetchNavLink key={item.path} path={item.path} label={item.label} />
          ))}
        </nav>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">
        {children}
      </main>
    </div>
  );
}

interface PrefetchNavLinkProps {
  path: StaticPath;
  label: string;
}

function PrefetchNavLink({ path, label }: PrefetchNavLinkProps): JSX.Element {
  const [location] = useLocation();
  const isActive = location === path || location.startsWith(`${ROUTES.chat}/`);
  const onEnter = useCallback(() => {
    if (path === ROUTES.chat) {
      void import("../routes/ChatRoute");
    }
  }, [path]);
  return (
    <Link
      href={path}
      onMouseEnter={onEnter}
      onFocus={onEnter}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-transparent px-2.5 py-1 text-sm font-medium transition-colors",
        "hover:text-text hover:border-border",
        isActive && "bg-secondary text-text border-border",
      )}
    >
      <MessagesSquare aria-hidden className="size-4" />
      {label}
    </Link>
  );
}
