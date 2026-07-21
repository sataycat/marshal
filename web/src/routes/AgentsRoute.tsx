import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Download, ExternalLink, RefreshCw, Search, ShieldCheck, Wrench } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Badge } from "../components/ui/badge";
import { PageHeader } from "../components/PageHeader";
import { ReadinessBadge } from "../components/status";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { useConfirmContext } from "../components/ConfirmDialog";
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
import { fetchInstallCandidate, type InstallCandidate } from "../api/client";
import type { InstalledAgent, InstallationOperation, RegistryAgent } from "../types";
import { useToastStore } from "../state/toastStore";

const featuredAgentNames = ["claude", "codex", "devin", "copilot", "opencode", "gemini", "amp", "zed"];

interface PendingTrust {
  agent: RegistryAgent;
  candidate: InstallCandidate;
  mode: "install" | "update";
}

export function AgentsRoute(): JSX.Element {
  const [search, setSearch] = useState("");
  const [operationIds, setOperationIds] = useState<Record<string, string>>({});
  const [pendingTrust, setPendingTrust] = useState<PendingTrust | null>(null);
  const [preparingId, setPreparingId] = useState<string | null>(null);
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
  const { confirm } = useConfirmContext();
  const pushError = useToastStore((state) => state.pushError);
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
  const inventory = installed.data ?? [];
  const registryMatchFor = (entry: InstalledAgent): RegistryAgent | undefined =>
    (catalog.data?.agents ?? []).find((agent) => agent.id === entry.id);
  const isInstalled = (agent: RegistryAgent): boolean =>
    inventory.some((entry) => entry.id === agent.id && entry.version === agent.version && entry.status === "installed");

  const requestInstall = async (agent: RegistryAgent, mode: "install" | "update"): Promise<void> => {
    const key = `${agent.id}@${agent.version}:${mode}`;
    setPreparingId(key);
    try {
      const candidate = await client.fetchQuery({
        queryKey: [...queryKeys.registry, "candidate", agent.id, agent.version, "auto"],
        queryFn: () => fetchInstallCandidate(agent.id, agent.version),
      });
      setPendingTrust({ agent, candidate, mode });
    } catch (error) {
      pushError(error instanceof Error ? error.message : "Unable to prepare this installation.");
    } finally {
      setPreparingId(null);
    }
  };

  const confirmInstall = async (): Promise<void> => {
    if (!pendingTrust) return;
    const { agent, candidate, mode } = pendingTrust;
    const mutation = mode === "update" ? update : install;
    const operation = await mutation.mutateAsync({ agentId: agent.id, version: agent.version, distribution: candidate.distribution.kind });
    setOperationIds((current) => ({ ...current, [`${agent.id}@${agent.version}`]: operation.id }));
    setPendingTrust(null);
    await client.invalidateQueries({ queryKey: queryKeys.installedAgents });
  };

  const removeAgent = async (entry: InstalledAgent): Promise<void> => {
    const ok = await confirm({
      title: "Remove agent",
      message: `Remove the Marshal installation of ${entry.id} ${entry.version}?`,
      confirmLabel: "Remove",
    });
    if (!ok) return;
    await remove.mutateAsync({ agentId: entry.id, version: entry.version, installationId: entry.installation_id });
    await client.invalidateQueries({ queryKey: queryKeys.installedAgents });
  };
  const probeAgent = async (entry: InstalledAgent): Promise<void> => { await probe.mutateAsync({ agentId: entry.id, version: entry.version, installationId: entry.installation_id }); await client.invalidateQueries({ queryKey: queryKeys.installedAgents }); };
  const authenticateAgent = async (entry: InstalledAgent, methodId: string): Promise<void> => {
    try {
      await authenticate.mutateAsync({ agentId: entry.id, version: entry.version, methodId, installationId: entry.installation_id });
      await client.invalidateQueries({ queryKey: queryKeys.agentAuthentication(entry.id, entry.version, entry.installation_id) });
      await client.invalidateQueries({ queryKey: queryKeys.installedAgents });
    } catch (error) {
      pushError(error instanceof Error ? error.message : "Unable to start authentication.");
    }
  };

  const busy = install.isPending || update.isPending || setDefault.isPending || remove.isPending || probe.isPending || authenticate.isPending;
  const refreshing = refresh.isPending || catalog.data?.refresh?.status === "running";

  return (
    <div className="mx-auto w-full max-w-6xl overflow-y-auto px-4 py-6 md:px-8">
      <PageHeader
        eyebrow="ACP registry"
        title="Agents"
        description="Install a protocol-compatible coding agent, authenticate it, and bring it online for repository sessions."
        actions={
          <Button variant="outline" onClick={() => void runRefresh()} disabled={refreshing}>
            <RefreshCw className={refreshing ? "animate-spin" : ""} />
            {refreshing ? "Updating catalog…" : "Update catalog"}
          </Button>
        }
      />

      {stale && (
        <div className="mt-5 rounded-lg border border-warn-border bg-warn-bg px-4 py-3 text-sm text-warn">
          <strong>Showing a stale catalog.</strong> The last refresh failed: {catalog.data?.refresh?.error ?? "unknown error"}. The previous valid snapshot remains available.
        </div>
      )}
      {!catalog.data?.snapshot && catalog.data?.refresh?.status === "failed" && (
        <div className="mt-5 rounded-lg border border-border bg-panel px-4 py-3 text-sm text-muted-foreground">
          We couldn't load the agent catalog. Check that Marshal can reach the internet, then try again.
        </div>
      )}

      <section className="mt-8" aria-labelledby="installed-heading">
        <div className="flex items-baseline justify-between gap-4">
          <h2 id="installed-heading" className="text-sm font-semibold">Installed</h2>
          <span className="text-xs text-muted-foreground">{inventory.length === 0 ? "None yet" : `${inventory.length} installation${inventory.length === 1 ? "" : "s"}`}</span>
        </div>
        {inventory.length === 0 ? (
          <div className="mt-3 rounded-xl border border-dashed border-border px-6 py-8 text-center">
            <p className="text-sm font-medium">No agents installed</p>
            <p className="mt-1 text-sm text-muted-foreground">Choose an agent from the catalog below. Installation pins an exact version you can audit.</p>
          </div>
        ) : (
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            {inventory.map((entry) => (
              <InstalledCard
                key={entry.installation_id}
                entry={entry}
                registryAgent={registryMatchFor(entry)}
                activationOperation={(operations.data ?? []).find((operation) => operation.agent_id === entry.id && operation.version === entry.version && operation.installation_id === entry.installation_id) ?? null}
                onProbe={() => void probeAgent(entry)}
                onRemove={() => void removeAgent(entry)}
                onUpdate={registryMatchFor(entry) && registryMatchFor(entry)!.version !== entry.version
                  ? () => void requestInstall(registryMatchFor(entry)!, "update")
                  : null}
                onDefault={(installationId) => void setDefault.mutateAsync({ agentId: entry.id, installationId })}
                onAuthenticate={(methodId) => void authenticateAgent(entry, methodId)}
                busy={busy}
                preparing={preparingId !== null}
              />
            ))}
          </div>
        )}
      </section>

      <section className="mt-10" aria-labelledby="catalog-heading">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 id="catalog-heading" className="text-sm font-semibold">Catalog</h2>
          <label className="relative block sm:w-72">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="bg-panel pl-9" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by name or capability…" />
          </label>
        </div>
        {catalog.isPending || refreshing ? (
          <p className="mt-6 text-sm text-muted-foreground">Fetching registry snapshot…</p>
        ) : agents.length === 0 ? (
          <div className="mt-6 rounded-xl border border-dashed border-border px-6 py-12 text-center">
            <p className="text-sm font-medium">{catalog.data?.snapshot ? "No agents match this search" : "No agents are available yet"}</p>
            <p className="mt-1 text-sm text-muted-foreground">{catalog.data?.snapshot ? "Try a different name or description." : "Try updating the catalog."}</p>
          </div>
        ) : (
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {agents.map((agent) => (
              <CatalogCard
                key={agent.id}
                agent={agent}
                installed={isInstalled(agent)}
                operationId={operationIds[`${agent.id}@${agent.version}`] ?? null}
                onInstall={() => void requestInstall(agent, "install")}
                busy={busy}
                preparing={preparingId === `${agent.id}@${agent.version}:install`}
              />
            ))}
          </div>
        )}
      </section>

      <section className="mt-10" aria-labelledby="activity-heading">
        <h2 id="activity-heading" className="text-sm font-semibold">Recent activity</h2>
        <p className="mt-1 text-xs text-muted-foreground">Installations and updates keep running if you leave this page.</p>
        <div className="mt-3 space-y-1.5">
          {(operations.data ?? []).slice(0, 8).map((operation) => (
            <div key={operation.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-panel px-3 py-2 text-xs">
              <span className="font-mono font-medium">{operation.agent_id}@{operation.version}</span>
              <span className="text-muted-foreground">{operation.distribution}</span>
              <span className={operation.activation_status === "failed" || operation.status === "failed" ? "ml-auto text-error" : operation.activation_status === "ready" ? "ml-auto text-success" : "ml-auto text-primary"}>
                {operation.status === "installing" ? `Installing · ${operation.phase}` : operation.status !== "installed" ? operation.status : activationLabel(operation.activation_status)}
              </span>
              {operation.error && <span className="basis-full text-error">{operation.error_code ?? "failed"}: {operation.error}</span>}
              {operation.activation_error && <span className="basis-full text-error">{operation.activation_error_code ?? "activation_failed"}: {operation.activation_error}</span>}
            </div>
          ))}
          {operations.data?.length === 0 && <p className="text-xs text-muted-foreground">Nothing installed yet.</p>}
        </div>
      </section>

      {catalog.data?.snapshot && (
        <p className="mt-8 text-xs text-muted-foreground">
          Snapshot {catalog.data.snapshot.version} fetched {new Date(catalog.data.snapshot.fetched_at).toLocaleString()} from <code className="font-mono">{catalog.data.source}</code>
        </p>
      )}

      <TrustDialog
        pending={pendingTrust}
        busy={install.isPending || update.isPending}
        onCancel={() => setPendingTrust(null)}
        onConfirm={() => void confirmInstall()}
      />
    </div>
  );
}

function TrustDialog({ pending, busy, onCancel, onConfirm }: { pending: PendingTrust | null; busy: boolean; onCancel: () => void; onConfirm: () => void }): JSX.Element {
  const identity = pending?.candidate.distribution.kind === "binary" ? pending.candidate.distribution.archive_url : pending?.candidate.distribution.package;
  return (
    <Dialog open={pending !== null} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><ShieldCheck aria-hidden className="size-4 text-primary" />{pending?.mode === "update" ? "Update agent" : "Install agent"}</DialogTitle>
           <DialogDescription>
             This runs third-party code on your machine. After publication, Marshal immediately starts it to check ACP compatibility, authentication, and a temporary session. It does not assign the agent to a repository or unattended workflow.
           </DialogDescription>
        </DialogHeader>
        {pending && (
          <dl className="grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-2 rounded-lg border border-border bg-inset px-3.5 py-3 text-sm">
            <dt className="text-muted-foreground">Agent</dt><dd className="font-medium">{pending.agent.name} <span className="font-mono text-xs text-muted-foreground">v{pending.candidate.version}</span></dd>
            <dt className="text-muted-foreground">Source</dt><dd className="font-mono text-xs break-all">{pending.candidate.source}</dd>
            <dt className="text-muted-foreground">Distribution</dt><dd>{pending.candidate.distribution.kind}</dd>
            <dt className="text-muted-foreground">License</dt><dd>{pending.candidate.license}</dd>
            <dt className="text-muted-foreground">Identity</dt><dd className="font-mono text-xs break-all">{identity ?? "n/a"}</dd>
            <dt className="text-muted-foreground">Checksum</dt><dd className="font-mono text-xs break-all">{pending.candidate.checksum ?? "none — unverified binary"}</dd>
            <dt className="text-muted-foreground">Integrity</dt><dd className="text-xs">{pending.candidate.integrity_policy}</dd>
          </dl>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button onClick={onConfirm} disabled={busy}>
            <Download aria-hidden />
            {busy ? "Starting…" : pending?.mode === "update" ? "Install update" : "Install and run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function popularityScore(agent: RegistryAgent): number {
  const haystack = `${agent.id} ${agent.name}`.toLowerCase();
  const index = featuredAgentNames.findIndex((name) => haystack.includes(name));
  return index === -1 ? 0 : featuredAgentNames.length - index;
}

function AgentIcon({ agent, className }: { agent: RegistryAgent; className?: string }): JSX.Element {
  if (agent.icon) return <img src={agent.icon} alt="" className={className} />;
  return (
    <div className={className} aria-hidden>
      <span className="flex size-full items-center justify-center rounded-[inherit] bg-accent font-mono text-sm font-semibold text-primary">{agent.name.slice(0, 1)}</span>
    </div>
  );
}

function InstalledCard({ entry, registryAgent, activationOperation, onProbe, onRemove, onUpdate, onDefault, onAuthenticate, busy, preparing }: {
  entry: InstalledAgent;
  registryAgent: RegistryAgent | undefined;
  activationOperation: InstallationOperation | null;
  onProbe: () => void;
  onRemove: () => void;
  onUpdate: (() => void) | null;
  onDefault: (installationId: string) => void;
  onAuthenticate: (methodId: string) => void;
  busy: boolean;
  preparing: boolean;
}): JSX.Element {
  const authentication = useAgentAuthenticationQuery(entry.id, entry.version, entry.installation_id, entry.status === "installed");
  const cancel = useCancelAgentAuthenticationMutation();
  const auth = authentication.data?.authentication;
  const name = registryAgent?.name ?? entry.id;
  const activationBusy = entry.readiness_status === "probing" || activationOperation?.activation_status === "checking";

  return (
    <article className="flex flex-col rounded-xl border border-border bg-panel p-4">
      <div className="flex items-start gap-3">
        {registryAgent && <AgentIcon agent={registryAgent} className="size-10 shrink-0 rounded-lg border border-border bg-bg object-cover p-1" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="font-semibold tracking-tight">{name}</h3>
            {entry.is_default && <Badge tone="accent">Default</Badge>}
          </div>
          <p className="mt-0.5 font-mono text-xs text-muted-foreground">{entry.id}@{entry.version}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <ReadinessBadge status={entry.readiness_status} />
        </div>
      </div>

      <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <div className="flex gap-1.5"><dt>Distribution</dt><dd className="font-medium text-text">{entry.distribution}</dd></div>
        <div className="flex gap-1.5"><dt>Integrity</dt><dd className={entry.integrity_status === "verified" ? "font-medium text-success" : entry.integrity_status === "mismatch" ? "font-medium text-error" : "font-medium text-text"}>{entry.integrity_status.replaceAll("_", " ")}</dd></div>
        {entry.protocol_version !== null && <div className="flex gap-1.5"><dt>ACP</dt><dd className="font-medium text-text">v{entry.protocol_version}</dd></div>}
        {entry.capabilities && <div className="flex gap-1.5"><dt>Images</dt><dd className="font-medium text-text">{entry.capabilities.prompt.image ? "supported" : "no"}</dd></div>}
      </dl>

      {entry.status === "failed" && <p className="mt-3 rounded-lg border border-error-border bg-error-bg px-3 py-2 text-xs text-error">Installation failed: {entry.failure ?? "unknown error"}</p>}
      {entry.status === "installed" && entry.readiness_status === "probing" && <p className="mt-3 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-primary">Checking agent startup, ACP negotiation, and a temporary session.</p>}
      {entry.readiness_status === "authentication_required" && <p className="mt-3 rounded-lg border border-warn-border bg-warn-bg px-3 py-2 text-xs text-warn">Sign in to this agent, then Marshal will check readiness again automatically.</p>}
      {entry.readiness_status === "failed" && (entry.readiness_error || activationOperation?.activation_diagnostic) && <div className="mt-3 rounded-lg border border-error-border bg-error-bg px-3 py-2 text-xs text-error"><p>Setup failed: {entry.readiness_error ?? activationOperation?.activation_diagnostic?.message}</p><p className="mt-1 text-error/80">{activationOperation?.activation_diagnostic?.action ?? "Retry the readiness check after reviewing the installation."}</p></div>}
      {auth && auth.status !== "succeeded" && (
        <div className="mt-3 rounded-lg border border-border bg-inset px-3 py-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span>Authentication {auth.status}</span>
            {auth.status === "authenticating" && <Button variant="ghost" size="xs" onClick={() => void cancel.mutateAsync(auth.id)} disabled={cancel.isPending}>Cancel</Button>}
          </div>
          {auth.error && <p className="mt-1 text-error">{auth.error}</p>}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3">
        {entry.readiness_status === "authentication_required" && entry.auth_methods.filter((method) => method.type === "agent").map((method) => (
          <Button key={method.id} size="sm" onClick={() => onAuthenticate(method.id)} disabled={busy || activationBusy}><ShieldCheck aria-hidden />Sign in with {method.name}</Button>
        ))}
        {onUpdate && <Button variant="outline" size="sm" onClick={onUpdate} disabled={busy || preparing}><Download aria-hidden />Update available</Button>}
        {entry.status === "installed" && !entry.is_default && <Button variant="outline" size="sm" onClick={() => onDefault(entry.installation_id)} disabled={busy}>Use by default</Button>}
        <Button variant="outline" size="sm" onClick={onProbe} disabled={busy || activationBusy} title="Check ACP initialization, authentication, capabilities, and a temporary session"><Wrench aria-hidden />Retry readiness check</Button>
        <Button variant="ghost" size="sm" className="ml-auto text-muted-foreground hover:text-error" onClick={onRemove} disabled={busy || activationBusy}>Remove</Button>
      </div>
    </article>
  );
}

function CatalogCard({ agent, installed, operationId, onInstall, busy, preparing }: {
  agent: RegistryAgent;
  installed: boolean;
  operationId: string | null;
  onInstall: () => void;
  busy: boolean;
  preparing: boolean;
}): JSX.Element {
  const operation = useInstallationQuery(operationId);
  const installing = operation.data && !["completed", "failed", "interrupted"].includes(operation.data.phase);

  return (
    <article className="flex min-h-0 flex-col rounded-xl border border-border bg-panel p-4 transition-colors hover:border-input">
      <div className="flex items-start gap-3">
        <AgentIcon agent={agent} className="size-10 shrink-0 rounded-lg border border-border bg-bg object-cover p-1" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate font-semibold tracking-tight">{agent.name}</h3>
            {popularityScore(agent) > 0 && <Badge tone="accent">Featured</Badge>}
          </div>
          <p className="truncate font-mono text-[0.6875rem] text-muted-foreground">{agent.id}</p>
        </div>
        <span className="shrink-0 font-mono text-[0.6875rem] text-muted-foreground">v{agent.version}</span>
      </div>
      <p className="mt-3 line-clamp-2 min-h-10 text-sm leading-5 text-muted-foreground">{agent.description}</p>
      <div className="mt-3 flex items-center gap-3 text-xs">
        {agent.repository && <a className="inline-flex items-center gap-1 text-primary hover:underline" href={agent.repository} target="_blank" rel="noreferrer">Source <ExternalLink className="size-3" /></a>}
        {agent.website && <a className="inline-flex items-center gap-1 text-primary hover:underline" href={agent.website} target="_blank" rel="noreferrer">Website <ExternalLink className="size-3" /></a>}
        <span className="ml-auto truncate text-muted-foreground">{agent.authors[0] ?? "Unknown author"}</span>
      </div>
      <div className="mt-3 border-t border-border pt-3">
        {installed ? (
          <p className="flex h-8 items-center gap-1.5 text-sm font-medium text-success"><Check className="size-4" />Installed</p>
        ) : (
          <Button className="w-full" onClick={onInstall} disabled={busy || agent.distributions.length === 0 || Boolean(installing) || preparing}>
            {installing || preparing ? <LoaderCircleSpin /> : <Download aria-hidden />}
            {installing ? "Installing…" : preparing ? "Preparing…" : "Install"}
          </Button>
        )}
      </div>
    </article>
  );
}

function LoaderCircleSpin(): JSX.Element {
  return (
    <svg className="size-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

function activationLabel(status: InstallationOperation["activation_status"]): string {
  if (status === "checking") return "Checking agent";
  if (status === "authentication_required") return "Sign in required";
  if (status === "ready") return "Ready";
  if (status === "failed") return "Setup failed";
  if (status === "interrupted") return "Activation interrupted";
  return "Installed";
}
