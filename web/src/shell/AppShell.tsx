import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { Activity, Bot, Boxes, ChevronsUpDown, MessagesSquare, PanelsTopLeft, Workflow } from "lucide-react";
import { useRepositoriesQuery, useRemoveRepositoryMutation, useSelectRepositoryMutation } from "../api/queries";
import { queryKeys } from "../api/queryKeys";
import { ThemeSettings } from "../components/ThemeSettings";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip";
import { ROUTES, type StaticPath } from "../routes/routes";
import { cn } from "@/lib/utils";

const tools: Array<{ path: StaticPath; label: string; icon: typeof Bot }> = [
  { path: ROUTES.chat, label: "Threads", icon: MessagesSquare },
  { path: ROUTES.agents, label: "Agents", icon: Bot },
  { path: ROUTES.workflows, label: "Workflows", icon: Workflow },
  { path: ROUTES.board, label: "Runs", icon: PanelsTopLeft },
  { path: ROUTES.diagnostics, label: "System", icon: Activity },
];

export function AppShell({ children, onboarding = false }: { children: React.ReactNode; onboarding?: boolean }): JSX.Element {
  const repositories = useRepositoriesQuery();
  const select = useSelectRepositoryMutation();
  const remove = useRemoveRepositoryMutation();
  const queryClient = useQueryClient();
  const selected = repositories.data?.repositories.find((repo) => repo.id === repositories.data.selected_repository_id);
  const changeRepository = async (id: string): Promise<void> => {
    await select.mutateAsync(id);
    await queryClient.invalidateQueries();
  };
  const unregister = async (): Promise<void> => {
    if (selected && window.confirm(`Remove ${selected.name} from Marshal? The checkout will not be deleted.`)) {
      await remove.mutateAsync(selected.id);
      await queryClient.invalidateQueries({ queryKey: queryKeys.repositories });
    }
  };

  return (
    <div className="flex h-svh overflow-hidden bg-bg text-text">
      <aside className="hidden w-[4.5rem] shrink-0 flex-col items-center border-r border-sidebar-border bg-sidebar py-3 text-sidebar-foreground md:flex">
        <Link href={ROUTES.home} className="mb-5 flex size-10 items-center justify-center rounded-xl bg-sidebar-primary text-sidebar-primary-foreground shadow-[0_0_28px_color-mix(in_oklch,var(--sidebar-primary)_22%,transparent)]" aria-label="Marshal home">
          <Boxes className="size-5" strokeWidth={2.3} aria-hidden />
        </Link>
        <nav className="flex flex-1 flex-col items-center gap-1" aria-label="Primary tools">
          {tools.map((item) => <ToolLink key={item.path} {...item} disabled={onboarding && item.path !== ROUTES.agents} />)}
        </nav>
        <div className="flex flex-col items-center gap-2"><ThemeSettings /><span className="size-2 rounded-full bg-success shadow-[0_0_9px_var(--success)]" title="Daemon online" /></div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center border-b border-border bg-panel/90 px-3 backdrop-blur-xl md:px-4">
          <Link href={ROUTES.home} className="mr-3 flex items-center gap-2 md:hidden"><span className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Boxes className="size-4" /></span><span className="text-sm font-semibold tracking-tight">Marshal</span></Link>
          {selected ? <div className="group relative flex min-w-0 items-center gap-2"><span className="hidden text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-muted sm:inline">Workspace</span><div className="relative"><select aria-label="Selected repository" value={selected.id} onChange={(event) => void changeRepository(event.target.value)} className="h-8 max-w-56 appearance-none rounded-md border-0 bg-transparent py-1 pl-2 pr-7 font-mono text-xs font-medium text-text outline-none hover:bg-secondary"><option value={selected.id}>{selected.name}</option>{(repositories.data?.repositories ?? []).filter((repo) => repo.id !== selected.id).map((repo) => <option key={repo.id} value={repo.id}>{repo.name}</option>)}</select><ChevronsUpDown className="pointer-events-none absolute right-1.5 top-1/2 size-3 -translate-y-1/2 text-muted" /></div><span className="hidden max-w-72 truncate font-mono text-[0.65rem] text-muted lg:inline">{selected.path}</span></div> : <span className="font-mono text-xs text-muted">No workspace selected</span>}
          <div className="ml-auto flex items-center gap-2"><span className="hidden items-center gap-1.5 font-mono text-[0.65rem] text-muted sm:flex"><span className="size-1.5 rounded-full bg-success" />local daemon</span>{selected && <button type="button" onClick={() => void unregister()} className="hidden text-[0.65rem] text-muted hover:text-danger lg:block">remove</button>}<div className="md:hidden"><ThemeSettings /></div></div>
        </header>
        <main className="flex min-h-0 flex-1 flex-col pb-14 md:pb-0">{children}</main>
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-50 flex h-14 items-center justify-around border-t border-sidebar-border bg-sidebar/95 px-2 text-sidebar-foreground backdrop-blur-xl md:hidden" aria-label="Primary tools">
        {tools.map((item) => <ToolLink key={item.path} {...item} mobile disabled={onboarding && item.path !== ROUTES.agents} />)}
      </nav>
    </div>
  );
}

function ToolLink({ path, label, icon: Icon, disabled = false, mobile = false }: { path: StaticPath; label: string; icon: typeof Bot; disabled?: boolean; mobile?: boolean }): JSX.Element {
  const [location] = useLocation();
  const isActive = location === path || (path === ROUTES.chat && location.startsWith(`${ROUTES.chat}/`));
  const onEnter = useCallback(() => { if (path === ROUTES.chat) void import("../routes/ChatRoute"); }, [path]);
  const content = <><Icon aria-hidden className={cn("size-[1.15rem]", isActive && "text-sidebar-primary")} /><span className={mobile ? "text-[0.6rem]" : "sr-only"}>{label}</span></>;
  if (disabled) return <span className={cn("flex cursor-not-allowed flex-col items-center gap-1 opacity-30", mobile ? "px-2 py-1" : "size-10 justify-center")}>{content}</span>;
  const link = <Link href={path} onMouseEnter={onEnter} onFocus={onEnter} className={cn("relative flex items-center justify-center text-sidebar-foreground/55 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground", mobile ? "min-w-12 flex-col gap-1 rounded-lg px-2 py-1" : "size-10 rounded-xl", isActive && "bg-sidebar-accent text-sidebar-foreground", isActive && !mobile && "after:absolute after:-left-[1.05rem] after:h-5 after:w-0.5 after:rounded-r after:bg-sidebar-primary")}>{content}</Link>;
  if (mobile) return link;
  return <TooltipProvider><Tooltip><TooltipTrigger render={<span />}>{link}</TooltipTrigger><TooltipContent side="right">{label}</TooltipContent></Tooltip></TooltipProvider>;
}
