import { Link, useLocation } from "wouter";
import { Settings } from "lucide-react";
import { MarshalMark } from "../components/MarshalMark";
import { NAV_ITEMS, ROUTES, type StaticPath } from "../routes/routes";
import { cn } from "@/lib/utils";

export function AppShell({ children, onboarding = false }: { children: React.ReactNode; onboarding?: boolean }): JSX.Element {
  return (
    <div className="flex min-h-svh min-w-0 flex-col bg-bg text-text">
      <Header onboarding={onboarding} />
      <main className="flex min-h-0 flex-1 flex-col">{children}</main>
    </div>
  );
}

function Header({ onboarding }: { onboarding: boolean }): JSX.Element {
  return (
    <header className="relative shrink-0 border-b border-border bg-panel">
      <div className="flex h-14 items-center gap-2 px-3 md:gap-5 md:px-5">
        <Link href={ROUTES.home} className="flex shrink-0 items-center gap-2" aria-label="Marshal home">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <MarshalMark className="size-[1.1rem]" />
          </span>
          <span className="hidden text-base font-semibold tracking-[-0.02em] sm:inline">Marshal</span>
        </Link>

        <nav className="flex h-full items-center gap-1" aria-label="Primary navigation">
          {NAV_ITEMS.map((item) => (
            <HeaderLink key={item.path} {...item} disabled={onboarding && item.path === ROUTES.chat} />
          ))}
        </nav>

        <div className="ml-auto flex items-center">
          <SettingsLink />
        </div>
      </div>
    </header>
  );
}

function HeaderLink({ path, label, disabled = false }: { path: StaticPath; label: string; disabled?: boolean }): JSX.Element {
  const [location] = useLocation();
  const isActive = location === path || (path === ROUTES.chat && location.startsWith(`${ROUTES.chat}/`));
  if (disabled) return <span className="flex h-9 cursor-not-allowed items-center rounded-lg px-3 text-sm font-medium text-muted-foreground opacity-45">{label}</span>;
  return (
    <Link
      href={path}
      onMouseEnter={() => { if (path === ROUTES.chat) void import("../routes/ChatRoute"); }}
      onFocus={() => { if (path === ROUTES.chat) void import("../routes/ChatRoute"); }}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "relative flex h-9 items-center rounded-lg px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-text",
        isActive && "bg-accent text-accent-foreground",
      )}
    >
      {label}
    </Link>
  );
}

function SettingsLink(): JSX.Element {
  const [location] = useLocation();
  const isActive = location === ROUTES.settings;
  return (
    <Link
      href={ROUTES.settings}
      aria-label="Settings"
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-text",
        isActive && "bg-accent text-accent-foreground",
      )}
    >
      <Settings aria-hidden className="size-4" />
    </Link>
  );
}
