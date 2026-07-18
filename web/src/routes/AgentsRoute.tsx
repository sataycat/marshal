import { useMemo, useState } from "react";
import { ExternalLink, RefreshCw, Search } from "lucide-react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../api/queryKeys";
import { useInstallRegistryAgentMutation, useInstalledAgentsQuery, useRefreshRegistryMutation, useRegistryQuery, useRemoveInstalledAgentMutation, useProbeInstalledAgentMutation } from "../api/queries";
import type { RegistryAgent } from "../types";

export function AgentsRoute(): JSX.Element {
  const [search, setSearch] = useState("");
  const catalog = useRegistryQuery();
  const installed = useInstalledAgentsQuery();
  const refresh = useRefreshRegistryMutation();
  const install = useInstallRegistryAgentMutation();
  const remove = useRemoveInstalledAgentMutation();
  const probe = useProbeInstalledAgentMutation();
  const client = useQueryClient();
  const agents = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (catalog.data?.agents ?? []).filter((agent) => !query || [agent.id, agent.name, agent.description].some((field) => field.toLowerCase().includes(query)));
  }, [catalog.data?.agents, search]);
  const stale = catalog.data?.snapshot && catalog.data.refresh?.status === "failed";
  const runRefresh = async (): Promise<void> => { await refresh.mutateAsync(); await client.invalidateQueries({ queryKey: queryKeys.registry }); };
  const installedFor = (agent: RegistryAgent) => installed.data?.find((entry) => entry.id === agent.id && entry.version === agent.version);
  const installAgent = async (agent: RegistryAgent): Promise<void> => {
    if (!window.confirm(`Install ${agent.name} ${agent.version} from the ACP Registry? This downloads and runs third-party code.`)) return;
    await install.mutateAsync({ agentId: agent.id, version: agent.version });
    await client.invalidateQueries({ queryKey: queryKeys.installedAgents });
  };
  const removeAgent = async (agent: RegistryAgent): Promise<void> => {
    if (!window.confirm(`Remove the Marshal installation of ${agent.name} ${agent.version}?`)) return;
    await remove.mutateAsync({ agentId: agent.id, version: agent.version });
    await client.invalidateQueries({ queryKey: queryKeys.installedAgents });
  };
  const probeAgent = async (agent: RegistryAgent): Promise<void> => { await probe.mutateAsync({ agentId: agent.id, version: agent.version }); await client.invalidateQueries({ queryKey: queryKeys.installedAgents }); };
  return <div className="mx-auto w-full max-w-6xl px-4 py-8 md:px-8">
    <div className="flex flex-col gap-5 border-b border-border pb-7 md:flex-row md:items-end md:justify-between">
      <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">ACP Registry</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Find your next coding partner</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-muted">Browse validated public metadata. Marshal does not execute registry data just because it appears here.</p></div>
      <Button variant="outline" onClick={() => void runRefresh()} disabled={refresh.isPending || catalog.data?.refresh?.status === "running"}><RefreshCw className={catalog.data?.refresh?.status === "running" ? "animate-spin" : ""} />{catalog.data?.refresh?.status === "running" ? "Refreshing" : "Refresh catalog"}</Button>
    </div>
    {stale && <div className="mt-5 rounded-lg border border-error-border bg-error-bg px-4 py-3 text-sm text-error"><strong>Showing a stale catalog.</strong> The last refresh failed: {catalog.data?.refresh?.error ?? "unknown error"}. The previous valid snapshot remains available.</div>}
    {!catalog.data?.snapshot && catalog.data?.refresh?.status === "failed" && <div className="mt-5 rounded-lg border border-border bg-panel px-4 py-3 text-sm text-muted">No valid catalog snapshot is available yet. Check the daemon network connection and try again.</div>}
    <label className="relative mt-7 block max-w-xl"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" /><Input className="h-10 pl-9" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by ID, name, or description" /></label>
    {catalog.isPending ? <p className="mt-10 text-sm text-muted">Loading catalog...</p> : agents.length === 0 ? <div className="mt-10 rounded-xl border border-dashed border-border px-6 py-12 text-center"><p className="font-medium">{catalog.data?.snapshot ? "No agents match this search" : "The catalog is empty"}</p><p className="mt-2 text-sm text-muted">{catalog.data?.snapshot ? "Try a different name, ID, or description." : "Refresh to load the public ACP Registry."}</p></div> : <div className="mt-7 grid gap-4 md:grid-cols-2 xl:grid-cols-3">{agents.map((agent) => <AgentCard key={agent.id} agent={agent} installed={installedFor(agent)} onInstall={() => void installAgent(agent)} onProbe={() => void probeAgent(agent)} onRemove={() => void removeAgent(agent)} busy={install.isPending || remove.isPending || probe.isPending} />)}</div>}
    {catalog.data?.snapshot && <p className="mt-7 text-xs text-muted">Snapshot {catalog.data.snapshot.version} fetched {new Date(catalog.data.snapshot.fetched_at).toLocaleString()} from <code>{catalog.data.source}</code></p>}
  </div>;
}

function AgentCard({ agent, installed, onInstall, onProbe, onRemove, busy }: { agent: RegistryAgent; installed?: { status: "installing" | "installed" | "failed"; failure: string | null; readiness_status: "unknown" | "probing" | "ready" | "authentication_required" | "failed"; readiness_error: string | null; protocol_version: number | null; capabilities: { prompt: { image: boolean } } | null }; onInstall: () => void; onProbe: () => void; onRemove: () => void; busy: boolean }): JSX.Element {
  return <article className="flex min-h-64 flex-col rounded-xl border border-border bg-panel p-5 shadow-sm transition-colors hover:border-primary/50">
    <div className="flex items-start gap-3">{agent.icon ? <img src={agent.icon} alt="" className="size-10 rounded-lg border border-border bg-bg p-1" /> : <div className="flex size-10 items-center justify-center rounded-lg bg-secondary text-lg font-semibold text-primary">{agent.name.slice(0, 1)}</div>}<div className="min-w-0 flex-1"><h2 className="truncate font-semibold">{agent.name}</h2><p className="truncate text-xs text-muted">{agent.id}</p></div><span className="rounded-full bg-secondary px-2 py-1 text-xs font-medium">v{agent.version}</span></div>
    <p className="mt-4 line-clamp-3 text-sm leading-5 text-muted">{agent.description}</p>
    <div className="mt-4 flex flex-wrap gap-1.5">{agent.distributions.map((distribution) => <span key={distribution.kind} className="rounded-md border border-border px-2 py-1 text-[0.7rem] font-medium uppercase tracking-wide">{distribution.kind}</span>)}<span className="rounded-md border border-border px-2 py-1 text-[0.7rem] font-medium">{agent.license}</span></div>
    {installed?.status === "failed" && <p className="mt-4 rounded-md border border-error-border bg-error-bg px-3 py-2 text-xs text-error">Installation failed: {installed.failure ?? "unknown error"}</p>}
    <div className="mt-auto flex items-center gap-3 pt-5 text-xs">{agent.repository && <a className="inline-flex items-center gap-1 text-primary hover:underline" href={agent.repository} target="_blank" rel="noreferrer">Source <ExternalLink className="size-3" /></a>}{agent.website && <a className="inline-flex items-center gap-1 text-primary hover:underline" href={agent.website} target="_blank" rel="noreferrer">Website <ExternalLink className="size-3" /></a>}<span className="ml-auto text-muted">{agent.authors[0] ?? "Unknown author"}</span></div>
     <div className="mt-4 flex items-center justify-between gap-2">{installed?.status === "installed" ? <><div className="flex flex-wrap items-center gap-2 text-xs"><span className="font-medium text-success">Installed</span>{installed.readiness_status === "ready" ? <span className="rounded-full bg-success/10 px-2 py-1 font-medium text-success">Ready</span> : installed.readiness_status === "authentication_required" ? <span className="rounded-full bg-warn/10 px-2 py-1 font-medium text-warn">Authentication required</span> : installed.readiness_status === "probing" ? <span className="text-primary">Probing...</span> : installed.readiness_status === "failed" ? <span className="text-danger">Probe failed</span> : null}</div><div className="flex gap-2"><Button variant="outline" size="sm" onClick={onProbe} disabled={busy}>{installed.readiness_status === "unknown" ? "Probe readiness" : "Probe again"}</Button><Button variant="outline" size="sm" onClick={onRemove} disabled={busy}>Remove</Button></div></> : installed?.status === "installing" ? <span className="text-xs font-medium text-primary">Installing...</span> : <Button size="sm" onClick={onInstall} disabled={busy || !agent.distributions.some((distribution) => distribution.kind === "npx")}>{installed?.status === "failed" ? "Retry installation" : "Install npx"}</Button>}</div>
     {installed?.readiness_status === "failed" && installed.readiness_error && <p className="mt-3 rounded-md border border-error-border bg-error-bg px-3 py-2 text-xs text-error">Readiness failed: {installed.readiness_error}</p>}
     {installed?.readiness_status === "ready" && installed.protocol_version !== null && <p className="mt-3 text-xs text-muted">ACP protocol {installed.protocol_version}. Image prompts: {installed.capabilities?.prompt.image ? "supported" : "not supported"}.</p>}
  </article>;
}
