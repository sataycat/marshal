import { useMemo, useState } from "react";
import { ExternalLink, RefreshCw, Search } from "lucide-react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../api/queryKeys";
import { useRefreshRegistryMutation, useRegistryQuery } from "../api/queries";
import type { RegistryAgent } from "../types";

export function AgentsRoute(): JSX.Element {
  const [search, setSearch] = useState("");
  const catalog = useRegistryQuery();
  const refresh = useRefreshRegistryMutation();
  const client = useQueryClient();
  const agents = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (catalog.data?.agents ?? []).filter((agent) => !query || [agent.id, agent.name, agent.description].some((field) => field.toLowerCase().includes(query)));
  }, [catalog.data?.agents, search]);
  const stale = catalog.data?.snapshot && catalog.data.refresh?.status === "failed";
  const runRefresh = async (): Promise<void> => { await refresh.mutateAsync(); await client.invalidateQueries({ queryKey: queryKeys.registry }); };
  return <div className="mx-auto w-full max-w-6xl px-4 py-8 md:px-8">
    <div className="flex flex-col gap-5 border-b border-border pb-7 md:flex-row md:items-end md:justify-between">
      <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">ACP Registry</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Find your next coding partner</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-muted">Browse validated public metadata. Marshal does not execute registry data just because it appears here.</p></div>
      <Button variant="outline" onClick={() => void runRefresh()} disabled={refresh.isPending || catalog.data?.refresh?.status === "running"}><RefreshCw className={catalog.data?.refresh?.status === "running" ? "animate-spin" : ""} />{catalog.data?.refresh?.status === "running" ? "Refreshing" : "Refresh catalog"}</Button>
    </div>
    {stale && <div className="mt-5 rounded-lg border border-error-border bg-error-bg px-4 py-3 text-sm text-error"><strong>Showing a stale catalog.</strong> The last refresh failed: {catalog.data?.refresh?.error ?? "unknown error"}. The previous valid snapshot remains available.</div>}
    {!catalog.data?.snapshot && catalog.data?.refresh?.status === "failed" && <div className="mt-5 rounded-lg border border-border bg-panel px-4 py-3 text-sm text-muted">No valid catalog snapshot is available yet. Check the daemon network connection and try again.</div>}
    <label className="relative mt-7 block max-w-xl"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" /><Input className="h-10 pl-9" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by ID, name, or description" /></label>
    {catalog.isPending ? <p className="mt-10 text-sm text-muted">Loading catalog...</p> : agents.length === 0 ? <div className="mt-10 rounded-xl border border-dashed border-border px-6 py-12 text-center"><p className="font-medium">{catalog.data?.snapshot ? "No agents match this search" : "The catalog is empty"}</p><p className="mt-2 text-sm text-muted">{catalog.data?.snapshot ? "Try a different name, ID, or description." : "Refresh to load the public ACP Registry."}</p></div> : <div className="mt-7 grid gap-4 md:grid-cols-2 xl:grid-cols-3">{agents.map((agent) => <AgentCard key={agent.id} agent={agent} />)}</div>}
    {catalog.data?.snapshot && <p className="mt-7 text-xs text-muted">Snapshot {catalog.data.snapshot.version} fetched {new Date(catalog.data.snapshot.fetched_at).toLocaleString()} from <code>{catalog.data.source}</code></p>}
  </div>;
}

function AgentCard({ agent }: { agent: RegistryAgent }): JSX.Element {
  return <article className="flex min-h-64 flex-col rounded-xl border border-border bg-panel p-5 shadow-sm transition-colors hover:border-primary/50">
    <div className="flex items-start gap-3">{agent.icon ? <img src={agent.icon} alt="" className="size-10 rounded-lg border border-border bg-bg p-1" /> : <div className="flex size-10 items-center justify-center rounded-lg bg-secondary text-lg font-semibold text-primary">{agent.name.slice(0, 1)}</div>}<div className="min-w-0 flex-1"><h2 className="truncate font-semibold">{agent.name}</h2><p className="truncate text-xs text-muted">{agent.id}</p></div><span className="rounded-full bg-secondary px-2 py-1 text-xs font-medium">v{agent.version}</span></div>
    <p className="mt-4 line-clamp-3 text-sm leading-5 text-muted">{agent.description}</p>
    <div className="mt-4 flex flex-wrap gap-1.5">{agent.distributions.map((distribution) => <span key={distribution.kind} className="rounded-md border border-border px-2 py-1 text-[0.7rem] font-medium uppercase tracking-wide">{distribution.kind}</span>)}<span className="rounded-md border border-border px-2 py-1 text-[0.7rem] font-medium">{agent.license}</span></div>
    <div className="mt-auto flex items-center gap-3 pt-5 text-xs">{agent.repository && <a className="inline-flex items-center gap-1 text-primary hover:underline" href={agent.repository} target="_blank" rel="noreferrer">Source <ExternalLink className="size-3" /></a>}{agent.website && <a className="inline-flex items-center gap-1 text-primary hover:underline" href={agent.website} target="_blank" rel="noreferrer">Website <ExternalLink className="size-3" /></a>}<span className="ml-auto text-muted">{agent.authors[0] ?? "Unknown author"}</span></div>
  </article>;
}
