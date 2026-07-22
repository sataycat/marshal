import { useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { Menu } from "@base-ui/react/menu";
import {
  Check,
  ChevronsUpDown,
  FolderGit2,
  Settings,
  Trash2,
} from "lucide-react";
import { useRepositoriesQuery, useRemoveRepositoryMutation, useSelectRepositoryMutation } from "../api/queries";
import { queryKeys } from "../api/queryKeys";
import { useConfirmContext } from "../components/ConfirmDialog";
import { useTaskStore } from "../state/taskStore";
import { MarshalMark } from "../components/MarshalMark";
import { NAV_ITEMS, ROUTES, type StaticPath } from "../routes/routes";
import { cn } from "@/lib/utils";

export function AppShell({ children, onboarding = false }: { children: React.ReactNode; onboarding?: boolean }): JSX.Element {
  const socketStatus = useTaskStore((state) => state.socketStatus);

  return (
    <div className="flex min-h-svh min-w-0 flex-col bg-bg text-text">
      <Header socketStatus={socketStatus} onboarding={onboarding} />
      <main className="flex min-h-0 flex-1 flex-col">{children}</main>
    </div>
  );
}

function Header({ socketStatus, onboarding }: { socketStatus: "open" | "connecting" | "closed"; onboarding: boolean }): JSX.Element {
  const repositories = useRepositoriesQuery();
  const select = useSelectRepositoryMutation();
  const remove = useRemoveRepositoryMutation();
  const queryClient = useQueryClient();
  const { confirm } = useConfirmContext();
  const selected = repositories.data?.repositories.find((repo) => repo.id === repositories.data.selected_repository_id);
  const all = repositories.data?.repositories ?? [];

  const changeRepository = async (id: string): Promise<void> => {
    if (id === selected?.id) return;
    await select.mutateAsync(id);
    await queryClient.invalidateQueries();
  };

  const unregister = async (): Promise<void> => {
    if (!selected) return;
    const ok = await confirm({
      title: "Remove repository",
      message: `Remove ${selected.name} from Marshal? The checkout on disk will not be deleted.`,
      confirmLabel: "Remove",
    });
    if (!ok) return;
    await remove.mutateAsync(selected.id);
    await queryClient.invalidateQueries({ queryKey: queryKeys.repositories });
  };

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

        <div className="ml-auto flex items-center gap-1.5 sm:gap-3">
          <span className="hidden items-center gap-1.5 text-xs text-muted-foreground lg:flex" title="Local daemon connection">
            <span className={cn("size-1.5 rounded-full", socketStatus === "open" ? "bg-success" : socketStatus === "connecting" ? "bg-warn" : "bg-error")} />
            {socketStatus === "open" ? "daemon online" : socketStatus === "connecting" ? "connecting" : "daemon offline"}
          </span>
          <SettingsLink />
        </div>
      </div>

      <div className="flex h-11 min-w-0 items-center gap-2 border-t border-border/70 px-3 md:absolute md:top-0 md:left-1/2 md:h-14 md:max-w-[40vw] md:-translate-x-1/2 md:border-0 md:px-0">
        <Menu.Root>
        <Menu.Trigger
          aria-label="Switch repository"
          className="flex h-8 min-w-0 items-center gap-2 rounded-lg border border-transparent px-2 text-sm font-medium text-text transition-colors hover:border-border hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring data-[popup-open]:border-border data-[popup-open]:bg-secondary"
        >
          <FolderGit2 aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">{selected ? selected.name : "No repository"}</span>
          <ChevronsUpDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner sideOffset={6} align="start" className="z-50">
            <Menu.Popup className="min-w-64 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl">
              <div className="px-2.5 pt-1.5 pb-1 text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Repositories</div>
              {all.length === 0 && <div className="px-2.5 py-2 text-sm text-muted-foreground">No repositories registered.</div>}
              {all.map((repo) => (
                <Menu.Item
                  key={repo.id}
                  onClick={() => void changeRepository(repo.id)}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm outline-none data-[highlighted]:bg-secondary"
                >
                  <span className="flex size-4 items-center justify-center">
                    {repo.id === selected?.id && <Check aria-hidden className="size-3.5 text-primary" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{repo.name}</span>
                    <span className="block truncate font-mono text-[0.6875rem] text-muted-foreground">{repo.path}</span>
                  </span>
                </Menu.Item>
              ))}
              {selected && (
                <>
                  <div className="mx-1 my-1 h-px bg-border" />
                  <Menu.Item
                    onClick={() => void unregister()}
                    className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-error outline-none data-[highlighted]:bg-error-bg"
                  >
                    <span className="flex size-4 items-center justify-center"><Trash2 aria-hidden className="size-3.5" /></span>
                    Remove {selected.name}…
                  </Menu.Item>
                </>
              )}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
        </Menu.Root>

        {selected && <span className="min-w-0 truncate font-mono text-[0.6875rem] text-muted-foreground md:max-w-60">{selected.path}</span>}
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
        isActive && "bg-accent text-accent-foreground after:absolute after:inset-x-3 after:-bottom-[0.625rem] after:h-0.5 after:rounded-full after:bg-primary",
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
        "flex h-9 items-center gap-2 rounded-lg px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-text sm:px-3",
        isActive && "bg-accent text-accent-foreground",
      )}
    >
      <Settings aria-hidden className="size-4" />
      <span className="hidden sm:inline">Settings</span>
    </Link>
  );
}
