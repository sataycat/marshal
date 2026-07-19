import { useMemo, useState } from "react";
import { ExternalLink, RefreshCw, Search } from "lucide-react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../api/queryKeys";
import { useAuthenticateInstalledAgentMutation, useCancelAgentAuthenticationMutation, useInstallRegistryAgentMutation, useInstalledAgentsQuery, useRefreshRegistryMutation, useRegistryQuery, useRemoveInstalledAgentMutation, useProbeInstalledAgentMutation, useAgentAuthenticationQuery, useInstallationQuery, useUpdateRegistryAgentMutation, useSetDefaultInstalledAgentMutation } from "../api/queries";
import type { RegistryAgent } from "../types";

export function AgentsRoute(): JSX.Element {
  const [search, setSearch] = useState("");
  const [operationIds, setOperationIds] = useState<Record<string, string>>({});
  const catalog = useRegistryQuery();
  const installed = useInstalledAgentsQuery();
  const refresh = useRefreshRegistryMutation();
  const install = useInstallRegistryAgentMutation();
  const update = useUpdateRegistryAgentMutation();
  const setDefault = useSetDefaultInstalledAgentMutation();
  const remove = useRemoveInstalledAgentMutation();
  const probe = useProbeInstalledAgentMutation();
  const authenticate = useAuthenticateInstalledAgentMutation();
  const client = useQueryClient();
  const agents = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (catalog.data?.agents ?? []).filter((agent) => !query || [agent.id, agent.name, agent.description].some((field) => field.toLowerCase().includes(query)));
  }, [catalog.data?.agents, search]);
  const stale = catalog.data?.snapshot && catalog.data.refresh?.status === "failed";
  const runRefresh = async (): Promise<void> => { await refresh.mutateAsync(); await client.invalidateQueries({ queryKey: queryKeys.registry }); };
  const installedFor = (agent: RegistryAgent) => installed.data?.filter((entry) => entry.id === agent.id && entry.version === agent.version);
  const installAgent = async (agent: RegistryAgent, distribution: "npx" | "uvx" | "binary"): Promise<void> => {
    if (!window.confirm(`Install ${agent.name} ${agent.version} from the ACP Registry? This downloads and runs third-party code.`)) return;
     const operation = await install.mutateAsync({ agentId: agent.id, version: agent.version, distribution });
     setOperationIds((current) => ({ ...current, [`${agent.id}@${agent.version}`]: operation.id }));
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
      {catalog.isPending ? <p className="mt-10 text-sm text-muted">Loading catalog...</p> : agents.length === 0 ? <div className="mt-10 rounded-xl border border-dashed border-border px-6 py-12 text-center"><p className="font-medium">{catalog.data?.snapshot ? "No agents match this search" : "The catalog is empty"}</p><p className="mt-2 text-sm text-muted">{catalog.data?.snapshot ? "Try a different name, ID, or description." : "Refresh to load the public ACP Registry."}</p></div> : <div className="mt-7 grid gap-4 md:grid-cols-2 xl:grid-cols-3">{agents.map((agent) => <AgentCard key={agent.id} agent={agent} installed={installedFor(agent)} operationId={operationIds[`${agent.id}@${agent.version}`] ?? null} onInstall={(distribution) => void installAgent(agent, distribution)} onProbe={() => void probeAgent(agent)} onAuthenticate={(methodId) => void authenticate.mutateAsync({ agentId: agent.id, version: agent.version, methodId })} onRemove={() => void removeAgent(agent)} onUpdate={() => void update.mutateAsync({ agentId: agent.id, version: agent.version })} onDefault={(installationId) => void setDefault.mutateAsync({ agentId: agent.id, installationId })} busy={install.isPending || update.isPending || setDefault.isPending || remove.isPending || probe.isPending || authenticate.isPending} />)}</div>}
    {catalog.data?.snapshot && <p className="mt-7 text-xs text-muted">Snapshot {catalog.data.snapshot.version} fetched {new Date(catalog.data.snapshot.fetched_at).toLocaleString()} from <code>{catalog.data.source}</code></p>}
  </div>;
}

function AgentCard({ agent, installed = [], operationId, onInstall, onProbe, onAuthenticate, onRemove, onUpdate, onDefault, busy }: { agent: RegistryAgent; installed?: Array<{ id: string; version: string; distribution: string; installation_id: string; is_default: boolean; status: "installing" | "installed" | "failed" | "interrupted"; integrity_status: string; provenance: { package_specifier: string | null; archive_identity: string | null }; failure: string | null; readiness_status: "unknown" | "probing" | "ready" | "authentication_required" | "failed"; readiness_error: string | null; protocol_version: number | null; capabilities: { prompt: { image: boolean } } | null; auth_methods: { id: string; type: "agent" | "terminal" | "env_var"; name: string; description: string | null }[] }>; operationId: string | null; onInstall: (distribution: "npx" | "uvx" | "binary") => void; onProbe: () => void; onAuthenticate: (methodId: string) => void; onRemove: () => void; onUpdate: () => void; onDefault: (installationId: string) => void; busy: boolean }): JSX.Element {
  const current = installed.find((entry) => entry.is_default) ?? installed[0];
   useInstallationQuery(operationId);
   const authentication = useAgentAuthenticationQuery(current?.id ?? agent.id, current?.version ?? agent.version, current?.status === "installed");
  const cancel = useCancelAgentAuthenticationMutation();
  const auth = authentication.data?.authentication;
   return <article className="flex min-h-64 flex-col rounded-xl border border-border bg-panel p-5 shadow-sm transition-colors hover:border-primary/50">
    <div className="flex items-start gap-3">{agent.icon ? <img src={agent.icon} alt="" className="size-10 rounded-lg border border-border bg-bg p-1" /> : <div className="flex size-10 items-center justify-center rounded-lg bg-secondary text-lg font-semibold text-primary">{agent.name.slice(0, 1)}</div>}<div className="min-w-0 flex-1"><h2 className="truncate font-semibold">{agent.name}</h2><p className="truncate text-xs text-muted">{agent.id}</p></div><span className="rounded-full bg-secondary px-2 py-1 text-xs font-medium">v{agent.version}</span></div>
    <p className="mt-4 line-clamp-3 text-sm leading-5 text-muted">{agent.description}</p>
    <div className="mt-4 flex flex-wrap gap-1.5">{agent.distributions.map((distribution) => <span key={distribution.kind} className="rounded-md border border-border px-2 py-1 text-[0.7rem] font-medium uppercase tracking-wide">{distribution.kind}</span>)}<span className="rounded-md border border-border px-2 py-1 text-[0.7rem] font-medium">{agent.license}</span></div>
     {installed.map((entry) => <div key={entry.installation_id} className="mt-3 rounded-md border border-border bg-bg px-3 py-2 text-xs"><div className="flex items-center justify-between"><strong>{entry.distribution} · {entry.version}</strong>{entry.is_default && <span className="text-success">Default</span>}</div><p className="mt-1 text-muted">{entry.integrity_status} · {entry.provenance.package_specifier ?? entry.provenance.archive_identity ?? "registry"} · {entry.readiness_status}</p>{entry.status === "installed" && !entry.is_default && <Button variant="ghost" size="sm" onClick={() => onDefault(entry.installation_id)} disabled={busy}>Use by default</Button>}</div>)}
     {current?.status === "failed" && <p className="mt-4 rounded-md border border-error-border bg-error-bg px-3 py-2 text-xs text-error">Installation failed: {current.failure ?? "unknown error"}</p>}
    <div className="mt-auto flex items-center gap-3 pt-5 text-xs">{agent.repository && <a className="inline-flex items-center gap-1 text-primary hover:underline" href={agent.repository} target="_blank" rel="noreferrer">Source <ExternalLink className="size-3" /></a>}{agent.website && <a className="inline-flex items-center gap-1 text-primary hover:underline" href={agent.website} target="_blank" rel="noreferrer">Website <ExternalLink className="size-3" /></a>}<span className="ml-auto text-muted">{agent.authors[0] ?? "Unknown author"}</span></div>
       <div className="mt-4 flex items-center justify-between gap-2">{current?.status === "installed" ? <><div className="flex flex-wrap items-center gap-2 text-xs"><span className="font-medium text-success">Installed</span>{current.readiness_status === "ready" ? <span className="rounded-full bg-success/10 px-2 py-1 font-medium text-success">Ready</span> : current.readiness_status === "authentication_required" ? <span className="rounded-full bg-warn/10 px-2 py-1 font-medium text-warn">Authentication required</span> : current.readiness_status === "probing" ? <span className="text-primary">Probing...</span> : current.readiness_status === "failed" ? <span className="text-danger">Probe failed</span> : null}</div><div className="flex gap-2">{current.readiness_status === "authentication_required" && current.auth_methods.filter((method) => method.type === "agent").map((method) => <Button key={method.id} variant="outline" size="sm" onClick={() => onAuthenticate(method.id)} disabled={busy}>Authenticate</Button>)}<Button variant="outline" size="sm" onClick={onUpdate} disabled={busy}>Update</Button><Button variant="outline" size="sm" onClick={onProbe} disabled={busy}>Probe again</Button><Button variant="outline" size="sm" onClick={onRemove} disabled={busy}>Remove</Button></div></> : <div className="flex gap-2">{(["npx", "uvx"] as const).filter((kind) => agent.distributions.some((distribution) => distribution.kind === kind)).map((kind) => <Button key={kind} size="sm" onClick={() => onInstall(kind)} disabled={busy}>Install {kind}</Button>)}</div>}</div>
      {current?.readiness_status === "failed" && current.readiness_error && <p className="mt-3 rounded-md border border-error-border bg-error-bg px-3 py-2 text-xs text-error">Readiness failed: {current.readiness_error}</p>}
     {auth && auth.status !== "succeeded" && <div className="mt-3 rounded-md border border-border bg-bg px-3 py-2 text-xs"><div className="flex items-center justify-between gap-2"><span>Authentication {auth.status}</span>{auth.status === "authenticating" && <Button variant="ghost" size="sm" onClick={() => void cancel.mutateAsync(auth.id)} disabled={cancel.isPending}>Cancel</Button>}</div>{auth.error && <p className="mt-1 text-error">{auth.error}</p>}</div>}
      {current?.readiness_status === "ready" && current.protocol_version !== null && <p className="mt-3 text-xs text-muted">ACP protocol {current.protocol_version}. Image prompts: {current.capabilities?.prompt.image ? "supported" : "not supported"}.</p>}
  </article>;
}
