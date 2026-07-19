import { useCallback } from "react";
import { Link, useLocation } from "wouter";
import { Bot, ClipboardList, MessagesSquare, Activity } from "lucide-react";
import { NAV_ITEMS, ROUTES, type StaticPath } from "../routes/routes";
import { cn } from "@/lib/utils";
import { useRepositoriesQuery, useRemoveRepositoryMutation, useSelectRepositoryMutation } from "../api/queries";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../api/queryKeys";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip";

export function AppShell({ children, onboarding = false }: { children: React.ReactNode; onboarding?: boolean }): JSX.Element {
  const repositories = useRepositoriesQuery();
  const select = useSelectRepositoryMutation();
  const remove = useRemoveRepositoryMutation();
  const queryClient = useQueryClient();
  const selected = repositories.data?.repositories.find((repo) => repo.id === repositories.data.selected_repository_id);
  const changeRepository = async (id: string): Promise<void> => { await select.mutateAsync(id); await queryClient.invalidateQueries(); await queryClient.invalidateQueries({ queryKey: queryKeys.repositories }); };
  const unregister = async (): Promise<void> => { if (selected && window.confirm(`Remove ${selected.name} from Marshal? The checkout will not be deleted.`)) { await remove.mutateAsync(selected.id); await queryClient.invalidateQueries({ queryKey: queryKeys.repositories }); } };
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
            <PrefetchNavLink key={item.path} path={item.path} label={item.label} disabled={onboarding && item.path !== ROUTES.agents} />
          ))}
        </nav>
        {selected && <div className="ml-auto flex items-center gap-2"><select aria-label="Selected repository" value={selected.id} onChange={(event) => void changeRepository(event.target.value)} className="max-w-56 rounded-md border border-input bg-transparent px-2 py-1 text-xs"><option value={selected.id}>{selected.name}</option>{(repositories.data?.repositories ?? []).filter((repo) => repo.id !== selected.id).map((repo) => <option key={repo.id} value={repo.id}>{repo.name}</option>)}</select><button type="button" onClick={() => void unregister()} className="text-xs text-muted hover:text-danger">Remove</button></div>}
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
  disabled?: boolean;
}

function PrefetchNavLink({ path, label, disabled = false }: PrefetchNavLinkProps): JSX.Element {
  const [location] = useLocation();
  const isActive = location === path || (path === ROUTES.chat && location.startsWith(`${ROUTES.chat}/`));
  const onEnter = useCallback(() => {
    if (path === ROUTES.chat) {
      void import("../routes/ChatRoute");
    }
  }, [path]);
  if (disabled) return <TooltipProvider><Tooltip><TooltipTrigger render={<span />}><span className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-md px-2.5 py-1 text-sm font-medium text-muted/60">{iconFor(path)}{label}</span></TooltipTrigger><TooltipContent>Connect a ready ACP server first</TooltipContent></Tooltip></TooltipProvider>;
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
       {iconFor(path)}
      {label}
    </Link>
  );
}

function iconFor(path: StaticPath): JSX.Element {
  return path === ROUTES.agents ? <Bot aria-hidden className="size-4" /> : path === ROUTES.board ? <ClipboardList aria-hidden className="size-4" /> : path === ROUTES.diagnostics ? <Activity aria-hidden className="size-4" /> : <MessagesSquare aria-hidden className="size-4" />;
}
