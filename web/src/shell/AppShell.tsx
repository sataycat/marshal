import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { Menu } from "@base-ui/react/menu";
import {
  Activity,
  Bot,
  Check,
  ChevronsUpDown,
  FolderGit2,
  MessagesSquare,
  SquareKanban,
  Trash2,
  Workflow,
} from "lucide-react";
import { useRepositoriesQuery, useRemoveRepositoryMutation, useSelectRepositoryMutation } from "../api/queries";
import { queryKeys } from "../api/queryKeys";
import { ThemeSettings } from "../components/ThemeSettings";
import { useConfirmContext } from "../components/ConfirmDialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip";
import { useTaskStore } from "../state/taskStore";
import { MarshalMark } from "../components/MarshalMark";
import { ROUTES, type StaticPath } from "../routes/routes";
import { cn } from "@/lib/utils";

const tools: Array<{ path: StaticPath; label: string; icon: typeof Bot }> = [
  { path: ROUTES.chat, label: "Threads", icon: MessagesSquare },
  { path: ROUTES.board, label: "Tasks", icon: SquareKanban },
  { path: ROUTES.agents, label: "Agents", icon: Bot },
  { path: ROUTES.workflows, label: "Workflows", icon: Workflow },
  { path: ROUTES.diagnostics, label: "Diagnostics", icon: Activity },
];

export function AppShell({ children, onboarding = false }: { children: React.ReactNode; onboarding?: boolean }): JSX.Element {
  const socketStatus = useTaskStore((state) => state.socketStatus);

  return (
    <div className="flex h-svh overflow-hidden bg-bg text-text">
      <aside className="hidden w-16 shrink-0 flex-col items-center border-r border-sidebar-border bg-sidebar py-3 text-sidebar-foreground md:flex">
        <Link
          href={ROUTES.home}
          className="mb-6 flex size-10 items-center justify-center rounded-xl bg-sidebar-primary text-sidebar-primary-foreground transition-transform hover:scale-[1.04]"
          aria-label="Marshal home"
        >
          <MarshalMark className="size-5" />
        </Link>
        <nav className="flex flex-1 flex-col items-center gap-1" aria-label="Primary tools">
          {tools.map((item, index) => (
            <ToolLink key={item.path} {...item} separated={index === 2 || index === 4} disabled={onboarding && item.path !== ROUTES.agents} />
          ))}
        </nav>
        <div className="flex flex-col items-center gap-3">
          <ThemeSettings />
          <span
            className={cn(
              "size-2 rounded-full",
              socketStatus === "open" ? "bg-success" : socketStatus === "connecting" ? "bg-warn" : "bg-error",
            )}
            title={socketStatus === "open" ? "Daemon connected" : socketStatus === "connecting" ? "Connecting to daemon" : "Daemon disconnected"}
          />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <Header socketStatus={socketStatus} />
        <main className="flex min-h-0 flex-1 flex-col pb-14 md:pb-0">{children}</main>
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-50 flex h-14 items-center justify-around border-t border-sidebar-border bg-sidebar/95 px-2 text-sidebar-foreground backdrop-blur-xl md:hidden" aria-label="Primary tools">
        {tools.map((item) => <ToolLink key={item.path} {...item} mobile disabled={onboarding && item.path !== ROUTES.agents} />)}
      </nav>
    </div>
  );
}

function Header({ socketStatus }: { socketStatus: "open" | "connecting" | "closed" }): JSX.Element {
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
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-panel px-3 md:px-4">
      <Link href={ROUTES.home} className="flex items-center gap-2 md:hidden" aria-label="Marshal home">
        <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <MarshalMark className="size-4" />
        </span>
        <span className="text-sm font-semibold tracking-tight">Marshal</span>
      </Link>

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

      {selected && <span className="hidden max-w-72 truncate font-mono text-[0.6875rem] text-muted-foreground lg:inline">{selected.path}</span>}

      <div className="ml-auto flex items-center gap-3">
        <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex" title="Local daemon connection">
          <span className={cn("size-1.5 rounded-full", socketStatus === "open" ? "bg-success" : socketStatus === "connecting" ? "bg-warn" : "bg-error")} />
          {socketStatus === "open" ? "daemon online" : socketStatus === "connecting" ? "connecting" : "daemon offline"}
        </span>
        <div className="md:hidden"><ThemeSettings /></div>
      </div>
    </header>
  );
}

function ToolLink({ path, label, icon: Icon, disabled = false, mobile = false, separated = false }: { path: StaticPath; label: string; icon: typeof Bot; disabled?: boolean; mobile?: boolean; separated?: boolean }): JSX.Element {
  const [location] = useLocation();
  const isActive = location === path || (path === ROUTES.chat && location.startsWith(`${ROUTES.chat}/`));
  const onEnter = useCallback(() => { if (path === ROUTES.chat) void import("../routes/ChatRoute"); }, [path]);
  const content = (
    <>
      <Icon aria-hidden className={cn("size-[1.15rem]", isActive && "text-sidebar-primary")} />
      <span className={mobile ? "text-[0.6rem]" : "sr-only"}>{label}</span>
    </>
  );
  const divider = separated && !mobile ? <div aria-hidden className="my-2 h-px w-6 bg-sidebar-border" /> : null;
  if (disabled) return <>{divider}<span className={cn("flex cursor-not-allowed flex-col items-center gap-1 opacity-30", mobile ? "px-2 py-1" : "size-10 justify-center")}>{content}</span></>;
  const link = (
    <Link
      href={path}
      onMouseEnter={onEnter}
      onFocus={onEnter}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "relative flex items-center justify-center text-sidebar-foreground/55 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground",
        mobile ? "min-w-12 flex-col gap-1 rounded-lg px-2 py-1" : "size-10 rounded-xl",
        isActive && "bg-sidebar-accent text-sidebar-foreground",
        isActive && !mobile && "after:absolute after:-left-3 after:h-5 after:w-0.5 after:rounded-r after:bg-sidebar-primary",
      )}
    >
      {content}
    </Link>
  );
  if (mobile) return link;
  return <>{divider}<TooltipProvider><Tooltip><TooltipTrigger render={<span />}>{link}</TooltipTrigger><TooltipContent side="right">{label}</TooltipContent></Tooltip></TooltipProvider></>;
}
