import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Download, ExternalLink, RefreshCw, Search } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { queryKeys } from "../api/queryKeys";
import {
  useAgentAuthenticationQuery,
  useAuthenticateInstalledAgentMutation,
  useCancelAgentAuthenticationMutation,
  useInstallRegistryAgentMutation,
  useInstalledAgentsQuery,
  useInstallationOperationsQuery,
  useInstallationQuery,
  useProbeInstalledAgentMutation,
  useRefreshRegistryMutation,
  useRegistryQuery,
  useRemoveInstalledAgentMutation,
  useSetDefaultInstalledAgentMutation,
  useUpdateRegistryAgentMutation,
} from "../api/queries";
import { fetchInstallCandidate } from "../api/client";
import type { InstalledAgent, RegistryAgent, RegistryDistribution } from "../types";

type DistributionKind = "npx" | "uvx" | "binary";

const featuredAgentNames = ["claude", "codex", "opencode", "gemini", "amp", "zed"];

export function AgentsRoute(): JSX.Element {
  const [search, setSearch] = useState("");
  const [operationIds, setOperationIds] = useState<Record<string, string>>({});
  const catalog = useRegistryQuery();
  const installed = useInstalledAgentsQuery();
  const operations = useInstallationOperationsQuery();
  const refresh = useRefreshRegistryMutation();
  const install = useInstallRegistryAgentMutation();
  const update = useUpdateRegistryAgentMutation();
  const setDefault = useSetDefaultInstalledAgentMutation();
  const remove = useRemoveInstalledAgentMutation();
  const probe = useProbeInstalledAgentMutation();
  const authenticate = useAuthenticateInstalledAgentMutation();
  const client = useQueryClient();
  const initialRefreshStarted = useRef(false);

  const runRefresh = async (): Promise<void> => {
    await refresh.mutateAsync();
    await client.invalidateQueries({ queryKey: queryKeys.registry });
  };

  useEffect(() => {
    if (!catalog.isPending && !catalog.data?.snapshot && !initialRefreshStarted.current && catalog.data?.refresh?.status !== "running") {
      initialRefreshStarted.current = true;
      void runRefresh();
    }
  }, [catalog.data?.refresh?.status, catalog.data?.snapshot, catalog.isPending]);

  const agents = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (catalog.data?.agents ?? [])
      .filter((agent) => !query || [agent.id, agent.name, agent.description].some((field) => field.toLowerCase().includes(query)))
      .sort((left, right) => popularityScore(right) - popularityScore(left) || left.name.localeCompare(right.name));
  }, [catalog.data?.agents, search]);

  const stale = catalog.data?.snapshot && catalog.data.refresh?.status === "failed";
  const installedFor = (agent: RegistryAgent): InstalledAgent[] => installed.data?.filter((entry) => entry.id === agent.id && entry.version === agent.version) ?? [];
  const orphaned = (installed.data ?? []).filter((entry) => !(catalog.data?.agents ?? []).some((agent) => agent.id === entry.id && agent.version === entry.version));

  const installAgent = async (agent: RegistryAgent, distribution: DistributionKind): Promise<void> => {
    const candidate = await client.fetchQuery({ queryKey: [...queryKeys.registry, "candidate", agent.id, agent.version, distribution], queryFn: () => fetchInstallCandidate(agent.id, agent.version, distribution) });
    const identity = candidate.distribution.kind === "binary" ? candidate.distribution.archive_url : candidate.distribution.package;
    if (!window.confirm(`Trust transition: install and allow third-party ACP code to run.\n\n${agent.name} ${candidate.version}\nSource: ${candidate.source}\nDistribution: ${candidate.distribution.kind}\nLicense: ${candidate.license}\nIdentity: ${identity ?? "n/a"}\nChecksum: ${candidate.checksum ?? "none (unverified binary)"}\nIntegrity policy: ${candidate.integrity_policy}`)) return;
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
  const updateAgent = async (agent: RegistryAgent): Promise<void> => {
    const current = installedFor(agent)[0];
    const candidate = await fetchInstallCandidate(agent.id, agent.version, current?.distribution as DistributionKind | undefined);
    if (!window.confirm(`Trust transition: install and allow the updated third-party ACP code to run.\n\n${agent.name} ${candidate.version}\nSource: ${candidate.source}\nDistribution: ${candidate.distribution.kind}\nLicense: ${candidate.license}\nChecksum: ${candidate.checksum ?? "none (unverified binary)"}`)) return;
    const operation = await update.mutateAsync({ agentId: agent.id, version: agent.version, distribution: candidate.distribution.kind });
    setOperationIds((currentIds) => ({ ...currentIds, [`${agent.id}@${agent.version}`]: operation.id }));
  };

  const busy = install.isPending || update.isPending || setDefault.isPending || remove.isPending || probe.isPending || authenticate.isPending;

  return <div className="mx-auto w-full max-w-7xl px-4 py-7 md:px-8">
    <div className="flex flex-col gap-5 border-b border-border pb-6 md:flex-row md:items-end md:justify-between">
      <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">Agent directory</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Choose an agent to talk to</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-muted">Find an agent, install it, and start a conversation in your project.</p></div>
      <Button variant="outline" onClick={() => void runRefresh()} disabled={refresh.isPending || catalog.data?.refresh?.status === "running"}><RefreshCw className={catalog.data?.refresh?.status === "running" ? "animate-spin" : ""} />{catalog.data?.refresh?.status === "running" ? "Updating agents" : "Update agent list"}</Button>
    </div>
    {stale && <div className="mt-5 rounded-lg border border-error-border bg-error-bg px-4 py-3 text-sm text-error"><strong>Showing a stale catalog.</strong> The last refresh failed: {catalog.data?.refresh?.error ?? "unknown error"}. The previous valid snapshot remains available.</div>}
    {!catalog.data?.snapshot && catalog.data?.refresh?.status === "failed" && <div className="mt-5 rounded-lg border border-border bg-panel px-4 py-3 text-sm text-muted">We couldn't load the agents right now. Check that Marshal can reach the internet, then try again.</div>}
    <label className="relative mt-6 block max-w-xl"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" /><Input className="h-10 pl-9" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search agents" /></label>
    {catalog.isPending || catalog.data?.refresh?.status === "running" ? <p className="mt-10 text-sm text-muted">Finding available agents...</p> : agents.length === 0 ? <div className="mt-10 rounded-xl border border-dashed border-border px-6 py-12 text-center"><p className="font-medium">{catalog.data?.snapshot ? "No agents match this search" : "No agents are available yet"}</p><p className="mt-2 text-sm text-muted">{catalog.data?.snapshot ? "Try a different name or description." : "Try updating the agent list."}</p></div> : <div className="mt-6 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{agents.map((agent) => <AgentCard key={agent.id} agent={agent} installed={installedFor(agent)} operationId={operationIds[`${agent.id}@${agent.version}`] ?? null} onInstall={(distribution) => void installAgent(agent, distribution)} onProbe={() => void probeAgent(agent)} onAuthenticate={(methodId) => void authenticate.mutateAsync({ agentId: agent.id, version: agent.version, methodId })} onRemove={() => void removeAgent(agent)} onUpdate={() => void updateAgent(agent)} onDefault={(installationId) => void setDefault.mutateAsync({ agentId: agent.id, installationId })} busy={busy} />)}</div>}
    {orphaned.length > 0 && <section className="mt-8 rounded-xl border border-border bg-panel p-5"><h2 className="font-semibold">Previously installed agents</h2><p className="mt-1 text-sm text-muted">These installed versions are still available even though they are not in the current agent list.</p><div className="mt-4 grid gap-2 md:grid-cols-2">{orphaned.map((entry) => <div key={entry.installation_id} className="rounded-md border border-border bg-bg px-3 py-2 text-xs"><strong>{entry.id}@{entry.version}</strong><p className="mt-1 text-muted">{entry.distribution} · {entry.integrity_status} · {entry.readiness_status}</p></div>)}</div></section>}
    <section className="mt-8 rounded-xl border border-border bg-panel p-5"><h2 className="font-semibold">Recent activity</h2><p className="mt-1 text-sm text-muted">Installations and updates keep running if you leave this page.</p><div className="mt-4 space-y-2">{(operations.data ?? []).slice(0, 8).map((operation) => <div key={operation.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-bg px-3 py-2 text-xs"><span><strong>{operation.agent_id}@{operation.version}</strong> · {operation.distribution}</span><span className={operation.status === "failed" ? "text-danger" : operation.status === "installed" ? "text-success" : "text-primary"}>{operation.status === "installing" ? `Installing · ${operation.phase}` : operation.status}</span>{operation.error && <span className="basis-full text-danger">{operation.error_code ?? "failed"}: {operation.error}</span>}</div>)}{operations.data?.length === 0 && <p className="text-xs text-muted">Nothing installed yet.</p>}</div></section>
    {catalog.data?.snapshot && <p className="mt-7 text-xs text-muted">Snapshot {catalog.data.snapshot.version} fetched {new Date(catalog.data.snapshot.fetched_at).toLocaleString()} from <code>{catalog.data.source}</code></p>}
  </div>;
}

function popularityScore(agent: RegistryAgent): number {
  const haystack = `${agent.id} ${agent.name}`.toLowerCase();
  const index = featuredAgentNames.findIndex((name) => haystack.includes(name));
  return index === -1 ? 0 : featuredAgentNames.length - index;
}

function preferredDistribution(agent: RegistryAgent): RegistryDistribution | undefined {
  return agent.distributions.find((distribution) => distribution.kind === "binary") ?? agent.distributions.find((distribution) => distribution.kind === "npx") ?? agent.distributions.find((distribution) => distribution.kind === "uvx");
}

function AgentCard({ agent, installed, operationId, onInstall, onProbe, onAuthenticate, onRemove, onUpdate, onDefault, busy }: { agent: RegistryAgent; installed: InstalledAgent[]; operationId: string | null; onInstall: (distribution: DistributionKind) => void; onProbe: () => void; onAuthenticate: (methodId: string) => void; onRemove: () => void; onUpdate: () => void; onDefault: (installationId: string) => void; busy: boolean }): JSX.Element {
  const current = installed.find((entry) => entry.is_default) ?? installed[0];
  const operation = useInstallationQuery(operationId);
  const authentication = useAgentAuthenticationQuery(current?.id ?? agent.id, current?.version ?? agent.version, current?.status === "installed");
  const cancel = useCancelAgentAuthenticationMutation();
  const auth = authentication.data?.authentication;
  const preferred = preferredDistribution(agent);
  const installing = operation.data && !["completed", "failed", "interrupted"].includes(operation.data.phase);

  return <article className="flex min-h-0 flex-col rounded-xl border border-border bg-[color-mix(in_oklch,var(--background)_80%,white)] p-5 shadow-sm transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-md">
    <div className="flex items-start gap-2.5">{agent.icon ? <img src={agent.icon} alt="" className="size-9 rounded-md border border-border bg-bg p-1" /> : <div className="flex size-9 items-center justify-center rounded-md bg-secondary text-base font-semibold text-primary">{agent.name.slice(0, 1)}</div>}<div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h2 className="truncate font-semibold">{agent.name}</h2>{popularityScore(agent) > 0 && <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[0.65rem] font-semibold text-primary">Popular</span>}</div><p className="truncate text-[0.7rem] text-muted">{agent.id}</p></div><span className="text-xs font-medium text-muted">v{agent.version}</span></div>
    <p className="mt-4 line-clamp-2 min-h-10 text-sm leading-5 text-muted">{agent.description}</p>
    {installed.map((entry) => <div key={entry.installation_id} className="mt-3 rounded-md border border-border bg-bg px-2.5 py-2 text-xs"><div className="flex items-center justify-between"><strong>{entry.distribution} · {entry.version}</strong>{entry.is_default && <span className="text-success">Default</span>}</div><p className="mt-1 text-muted">{entry.integrity_status} · {entry.readiness_status === "ready" ? "Ready" : entry.readiness_status === "authentication_required" ? "Authentication required" : entry.status === "installed" ? "Installed" : entry.status}</p>{entry.status === "installed" && !entry.is_default && <Button variant="ghost" size="xs" onClick={() => onDefault(entry.installation_id)} disabled={busy}>Use by default</Button>}</div>)}
    {current?.status === "failed" && <p className="mt-3 rounded-md border border-error-border bg-error-bg px-2.5 py-2 text-xs text-error">Installation failed: {current.failure ?? "unknown error"}</p>}
    <div className="mt-auto flex items-center gap-3 border-t border-border pt-4 text-xs">{agent.repository && <a className="inline-flex items-center gap-1 text-primary hover:underline" href={agent.repository} target="_blank" rel="noreferrer">Source <ExternalLink className="size-3" /></a>}{agent.website && <a className="inline-flex items-center gap-1 text-primary hover:underline" href={agent.website} target="_blank" rel="noreferrer">Website <ExternalLink className="size-3" /></a>}<span className="ml-auto truncate text-muted">{agent.authors[0] ?? "Unknown author"}</span></div>
    <div className="mt-3 flex items-center justify-between gap-2">{current?.status === "installed" ? <><div className="flex flex-wrap items-center gap-2 text-xs"><span className="inline-flex items-center gap-1 font-medium text-success"><Check className="size-3.5" />Installed</span>{current.readiness_status === "ready" ? <span className="rounded-full bg-success/10 px-2 py-1 font-medium text-success">Ready</span> : current.readiness_status === "authentication_required" ? <span className="rounded-full bg-warn/10 px-2 py-1 font-medium text-warn">Auth needed</span> : current.readiness_status === "probing" ? <span className="text-primary">Probing...</span> : current.readiness_status === "failed" ? <span className="text-danger">Probe failed</span> : null}</div><div className="flex gap-1">{current.readiness_status === "authentication_required" && current.auth_methods.filter((method) => method.type === "agent").map((method) => <Button key={method.id} variant="outline" size="sm" onClick={() => onAuthenticate(method.id)} disabled={busy}>Authenticate</Button>)}<Button variant="outline" size="sm" onClick={onUpdate} disabled={busy}>Update</Button><Button variant="outline" size="sm" onClick={onProbe} disabled={busy}>Probe</Button><Button variant="outline" size="sm" onClick={onRemove} disabled={busy}>Remove</Button></div></> : <Button className="h-10 w-full border border-primary/20 bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/85 hover:shadow-md" size="lg" onClick={() => preferred && onInstall(preferred.kind)} disabled={busy || !preferred || Boolean(installing)}><Download className="size-4" />{installing ? "Installing agent..." : "Install agent"}</Button>}</div>
    {current?.readiness_status === "failed" && current.readiness_error && <p className="mt-2 rounded-md border border-error-border bg-error-bg px-2.5 py-2 text-xs text-error">Readiness failed: {current.readiness_error}</p>}
    {current?.readiness_status === "ready" && current.protocol_version !== null && <p className="mt-2 text-xs text-muted">ACP {current.protocol_version} · Images {current.capabilities?.prompt.image ? "supported" : "not supported"}</p>}
    {auth && auth.status !== "succeeded" && <div className="mt-2 rounded-md border border-border bg-bg px-2.5 py-2 text-xs"><div className="flex items-center justify-between gap-2"><span>Authentication {auth.status}</span>{auth.status === "authenticating" && <Button variant="ghost" size="xs" onClick={() => void cancel.mutateAsync(auth.id)} disabled={cancel.isPending}>Cancel</Button>}</div>{auth.error && <p className="mt-1 text-error">{auth.error}</p>}</div>}
  </article>;
}
