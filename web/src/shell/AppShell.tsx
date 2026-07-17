import { useCallback } from "react";
import { Link, useLocation } from "wouter";
import { KanbanSquare, MessagesSquare, ArrowLeftRight } from "lucide-react";
import { NAV_ITEMS, ROUTES, type StaticPath } from "../routes/routes";
import { useTaskStore } from "../state/taskStore";
import { cn } from "@/lib/utils";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function AppShell({ children }: { children: React.ReactNode }): JSX.Element {
  const status = useTaskStore((state) => state.socketStatus);
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
        <div className="ml-auto flex items-center md:ml-0">
          <span
            className={cn(
              "text-xs font-medium tracking-wider uppercase",
              status === "open" && "text-[var(--color-success)]",
              (status === "closed" || status === "connecting") &&
                "text-[var(--color-warn)]",
            )}
            title={`WebSocket: ${status}`}
          >
            {status}
          </span>
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col pb-14 md:pb-0">
        {children}
      </main>
      <MobileBottomNav />
    </div>
  );
}

function MobileBottomNav(): JSX.Element {
  const [location, navigate] = useLocation();
  const value: StaticPath = location.startsWith(ROUTES.chat)
    ? ROUTES.chat
    : ROUTES.board;
  const onChange = useCallback(
    (next: string) => {
      if (next === ROUTES.board || next === ROUTES.chat) {
        void navigate(next as StaticPath);
      }
    },
    [navigate],
  );
  return (
    <Tabs
      value={value}
      onValueChange={onChange}
      className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-panel/95 px-2 pt-1 pb-2 backdrop-blur md:hidden"
    >
      <TabsList className="w-full">
        <TabsTrigger value={ROUTES.board} className="flex-1">
          <KanbanSquare aria-hidden className="size-4" />
          Board
        </TabsTrigger>
        <TabsTrigger value={ROUTES.chat} className="flex-1">
          <MessagesSquare aria-hidden className="size-4" />
          Chat
        </TabsTrigger>
        <TabsTrigger value="__back" disabled className="flex-1 opacity-60">
          <ArrowLeftRight aria-hidden className="size-4" />
          Detail
        </TabsTrigger>
      </TabsList>
    </Tabs>
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
  const Icon = path === ROUTES.board ? KanbanSquare : MessagesSquare;
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
      <Icon aria-hidden className="size-4" />
      {label}
    </Link>
  );
}
