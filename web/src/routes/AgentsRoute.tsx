import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Download, ExternalLink, MessageSquare, RefreshCw, Search, ShieldCheck, Wrench } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, buttonVariants } from "../components/ui/button";
import { Link } from "wouter";
import { Input } from "../components/ui/input";
import { Badge } from "../components/ui/badge";
import { PageHeader } from "../components/PageHeader";
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
import { connectTerminalAuthentication, fetchInstallCandidate, fetchTerminalAuthentication } from "../api/client";
import type { AgentAuthenticationOperation, InstalledAgent, InstallationOperation, RegistryAgent, TerminalAuthSnapshot } from "../types";
import { useToastStore } from "../state/toastStore";
import { cn } from "../lib/utils";
import { installedCardState } from "../agents/installedCardState";
import { authMethodSupport } from "../agents/authMethodSupport";

const featuredAgentNames = ["claude", "codex", "devin", "copilot", "opencode", "gemini", "amp", "zed"];

export function AgentsRoute(): JSX.Element {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "installed" | "not-installed">("all");
  const [operationIds, setOperationIds] = useState<Record<string, string>>({});
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
      const mutation = mode === "update" ? update : install;
      const operation = await mutation.mutateAsync({ agentId: agent.id, version: agent.version, distribution: candidate.distribution.kind });
      setOperationIds((current) => ({ ...current, [`${agent.id}@${agent.version}`]: operation.id }));
      await client.invalidateQueries({ queryKey: queryKeys.installedAgents });
    } catch (error) {
      pushError(error instanceof Error ? error.message : "Unable to prepare this installation.");
    } finally {
      setPreparingId(null);
    }
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
  const authenticateAgent = async (entry: InstalledAgent, methodId: string, values?: Record<string, string>): Promise<AgentAuthenticationOperation | InstalledAgent | undefined> => {
    try {
      const result = await authenticate.mutateAsync({ agentId: entry.id, version: entry.version, methodId, installationId: entry.installation_id, values });
      await client.invalidateQueries({ queryKey: queryKeys.agentAuthentication(entry.id, entry.version, entry.installation_id) });
      await client.invalidateQueries({ queryKey: queryKeys.installedAgents });
      return result;
    } catch (error) {
      pushError(error instanceof Error ? error.message : "Unable to start authentication.");
    }
  };

  const busy = install.isPending || update.isPending || setDefault.isPending || remove.isPending || probe.isPending || authenticate.isPending;
  const refreshing = refresh.isPending || catalog.data?.refresh?.status === "running";

  return (
      <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8">
      <PageHeader
        eyebrow="ACP registry"
        title="Agents"
        description="Discover, install, and use protocol-compatible coding agents for repository sessions."
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

      <section className="mt-6" aria-labelledby="catalog-heading">
        <label className="relative block w-full">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="bg-panel pl-9" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search agents by name or capability…" />
        </label>
        <div className="mt-3 flex flex-wrap items-center gap-1 border-b border-border" role="tablist" aria-label="Agent filters">
          {(["all", "installed", "not-installed"] as const).map((value) => (
            <button key={value} type="button" role="tab" aria-selected={filter === value} onClick={() => setFilter(value)} className={cn("border-b-2 px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors", filter === value ? "border-primary text-text" : "border-transparent hover:text-text")}>
              {value === "all" ? "All" : value === "installed" ? `Installed${inventory.length ? ` · ${inventory.length}` : ""}` : "Discover"}
            </button>
          ))}
        </div>
        {(() => {
          const visible = filteredAgents(catalog.data?.agents ?? [], inventory, search, filter);
          const visibleInstalled = inventory.filter((entry) => matchesSearch(registryMatchFor(entry) ?? { id: entry.id, name: entry.id, description: "" }, search));
          const displayedInstalled = filter === "not-installed" ? [] : visibleInstalled;
          return (
            <>
              {catalog.isPending || refreshing ? (
                <p className="mt-6 text-sm text-muted-foreground">Fetching registry snapshot…</p>
              ) : visible.length === 0 && displayedInstalled.length === 0 ? (
                <div className="mt-6 rounded-xl border border-dashed border-border px-6 py-12 text-center">
                  <p className="text-sm font-medium">{catalog.data?.snapshot ? "No agents match this search" : "No agents are available yet"}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{catalog.data?.snapshot ? "Try a different name or description." : "Try updating the catalog."}</p>
                </div>
              ) : (
                <div className="mt-5 space-y-8">
                  {displayedInstalled.length > 0 && <section aria-labelledby="installed-agents-heading">
                    <div className="mb-3 flex items-baseline justify-between gap-3">
                      <h2 id="installed-agents-heading" className="text-sm font-semibold tracking-tight">Installed agents</h2>
                      <span className="text-xs text-muted-foreground">{displayedInstalled.length} {displayedInstalled.length === 1 ? "agent" : "agents"}</span>
                    </div>
                    <div className="grid items-start gap-3 md:grid-cols-2">
                      {displayedInstalled.map((entry) => (
                        <InstalledCard key={entry.installation_id} entry={entry} registryAgent={registryMatchFor(entry)} activationOperation={(operations.data ?? []).find((operation) => operation.agent_id === entry.id && operation.version === entry.version && operation.installation_id === entry.installation_id) ?? null} onProbe={() => void probeAgent(entry)} onRemove={() => void removeAgent(entry)} onUpdate={registryMatchFor(entry) && registryMatchFor(entry)!.version !== entry.version ? () => void requestInstall(registryMatchFor(entry)!, "update") : null} onDefault={(installationId) => void setDefault.mutateAsync({ agentId: entry.id, installationId })} onAuthenticate={(methodId, values) => authenticateAgent(entry, methodId, values)} busy={busy} preparing={preparingId !== null} />
                      ))}
                    </div>
                  </section>}
                  {visible.length > 0 && <section aria-labelledby="discover-agents-heading">
                    <div className="mb-3 flex items-baseline justify-between gap-3">
                      <h2 id="discover-agents-heading" className="text-sm font-semibold tracking-tight">Discover agents</h2>
                      <span className="text-xs text-muted-foreground">{visible.length} available</span>
                    </div>
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {visible.map((agent) => <CatalogCard key={agent.id} agent={agent} installed={isInstalled(agent)} operationId={operationIds[`${agent.id}@${agent.version}`] ?? null} onInstall={() => void requestInstall(agent, "install")} busy={busy} preparing={preparingId === `${agent.id}@${agent.version}:install`} />)}
                    </div>
                  </section>}
                </div>
              )}
            </>
          );
        })()}
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

    </div>
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

function matchesSearch(agent: Pick<RegistryAgent, "id" | "name" | "description">, search: string): boolean {
  const query = search.trim().toLowerCase();
  return !query || [agent.id, agent.name, agent.description].some((field) => field.toLowerCase().includes(query));
}

function filteredAgents(agents: RegistryAgent[], inventory: InstalledAgent[], search: string, filter: "all" | "installed" | "not-installed"): RegistryAgent[] {
  if (filter === "installed") return [];
  return agents
    .filter((agent) => matchesSearch(agent, search))
    .filter((agent) => {
      const installed = inventory.some((entry) => entry.id === agent.id && entry.version === agent.version && entry.status === "installed");
      return !installed;
    })
    .sort((left, right) => popularityScore(right) - popularityScore(left) || left.name.localeCompare(right.name));
}

function InstalledCard({ entry, registryAgent, activationOperation, onProbe, onRemove, onUpdate, onDefault, onAuthenticate, busy, preparing }: {
  entry: InstalledAgent;
  registryAgent: RegistryAgent | undefined;
  activationOperation: InstallationOperation | null;
  onProbe: () => void;
  onRemove: () => void;
  onUpdate: (() => void) | null;
  onDefault: (installationId: string) => void;
  onAuthenticate: (methodId: string, values?: Record<string, string>) => Promise<AgentAuthenticationOperation | InstalledAgent | undefined>;
  busy: boolean;
  preparing: boolean;
}): JSX.Element {
  const authentication = useAgentAuthenticationQuery(entry.id, entry.version, entry.installation_id, entry.status === "installed");
  const cancel = useCancelAgentAuthenticationMutation();
  const auth = authentication.data?.authentication;
  const name = registryAgent?.name ?? entry.id;
  const activationBusy = entry.readiness_status === "probing" || activationOperation?.activation_status === "checking";
  const cardState = installedCardState(entry.status, entry.readiness_status, auth?.status);
  const signInMethod = entry.auth_methods.find((method) => method.type === "agent");
  const [authValues, setAuthValues] = useState<Record<string, string>>({});
  const [terminal, setTerminal] = useState<TerminalAuthSnapshot | null>(null);
  const [terminalInput, setTerminalInput] = useState("");
  const terminalSocket = useRef<ReturnType<typeof connectTerminalAuthentication> | null>(null);
  const statusTone = cardState === "ready" ? "success" : cardState === "setup_needed" ? "error" : "neutral";
  const statusLabel = cardState === "ready" ? "Ready" : cardState === "setup_needed" ? "Error" : "Installed";

  useEffect(() => () => terminalSocket.current?.close(), []);
  useEffect(() => {
    if (auth?.method_type !== "terminal" || auth.status !== "authenticating" || terminal?.operation.id === auth.id) return;
    let cancelled = false;
    void fetchTerminalAuthentication(auth.id).then((snapshot) => {
      if (cancelled) return;
      setTerminal(snapshot);
      terminalSocket.current?.close();
      terminalSocket.current = connectTerminalAuthentication(auth.id, (message) => {
        if (message.type === "terminal.snapshot" || message.type === "terminal.state") setTerminal(message.payload as TerminalAuthSnapshot);
        if (message.type === "terminal.output") setTerminal((current) => current ? applyTerminalOutput(current, message.payload) : current);
      });
    }).catch(() => { /* polling will expose a reconciled terminal operation state */ });
    return () => { cancelled = true; };
  }, [auth?.id, auth?.method_type, auth?.status, terminal?.operation.id]);
  const openTerminal = async (methodId: string): Promise<void> => {
    const result = await onAuthenticate(methodId);
    if (!result || !("method_type" in result) || result.method_type !== "terminal") return;
    terminalSocket.current?.close();
    terminalSocket.current = connectTerminalAuthentication(result.id, (message) => {
      if (message.type === "terminal.snapshot" || message.type === "terminal.state") setTerminal(message.payload as TerminalAuthSnapshot);
      if (message.type === "terminal.output") setTerminal((current) => current ? applyTerminalOutput(current, message.payload) : current);
    });
  };

  return (
    <article className={cn(
      "flex flex-col overflow-hidden rounded-xl border bg-panel transition-colors hover:border-input",
      cardState === "setup_needed" ? "border-error-border" : "border-border",
    )}>
      <div className="p-4">
      <div className="flex items-start gap-3">
        {registryAgent && <AgentIcon agent={registryAgent} className="size-11 shrink-0 rounded-lg border border-border bg-bg object-cover p-1" />}
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold tracking-tight">{name}</h3>
          <p className="mt-0.5 font-mono text-xs text-muted-foreground">{entry.id}@{entry.version}</p>
        </div>
        <Badge tone={statusTone} className="mt-0.5"><span aria-hidden className={cn("size-1.5 rounded-full", cardState === "ready" ? "bg-success" : cardState === "setup_needed" ? "bg-error" : "bg-muted-foreground")} />{statusLabel}</Badge>
      </div>

      {entry.status === "failed" && <p className="mt-3 rounded-lg border border-error-border bg-error-bg px-3 py-2 text-xs text-error">Installation failed: {entry.failure ?? "unknown error"}</p>}
      {entry.status === "installed" && entry.readiness_status === "probing" && <p className="mt-3 text-sm text-muted-foreground">Marshal is getting this agent ready.</p>}
      {entry.readiness_status === "authentication_required" && <p className="mt-3 rounded-lg border border-warn-border bg-warn-bg px-3 py-2 text-xs text-warn">Sign in to this agent, then Marshal will check readiness again automatically.</p>}
      {entry.readiness_status === "authentication_required" && entry.auth_methods.filter((method) => method.type === "env_var").map((method) => (
        <form key={method.id} className="mt-3 rounded-lg border border-border bg-inset p-3" onSubmit={(event) => { event.preventDefault(); onAuthenticate(method.id, authValues); }}>
          <p className="text-sm font-medium">{method.name}</p>
          {method.description && <p className="mt-1 text-xs text-muted-foreground">{method.description}</p>}
          {method.link && <a className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline" href={method.link} target="_blank" rel="noreferrer">Get credentials <ExternalLink className="size-3" /></a>}
          <div className="mt-3 space-y-2">
            {method.vars.map((variable) => <label key={variable.name} className="block text-xs"><span className="mb-1 block font-medium text-text">{variable.label ?? variable.name}{variable.optional ? " (optional)" : ""}</span><Input type={variable.secret ? "password" : "text"} name={variable.name} autoComplete="off" required={!variable.optional} value={authValues[variable.name] ?? ""} onChange={(event) => setAuthValues((current) => ({ ...current, [variable.name]: event.target.value }))} /></label>)}
          </div>
          <Button className="mt-3" size="sm" type="submit" disabled={busy || activationBusy}><ShieldCheck aria-hidden />Save and check setup</Button>
        </form>
      ))}
      {entry.readiness_status === "authentication_required" && entry.auth_methods.filter((method) => method.type === "terminal" && authMethodSupport(method).supported).map((method) => (
        <div key={method.id} className="mt-3 rounded-lg border border-border bg-inset p-3">
          <p className="text-sm font-medium">{method.name}</p>
          {method.description && <p className="mt-1 text-xs text-muted-foreground">{method.description}</p>}
          <p className="mt-2 rounded border border-warn-border bg-warn-bg px-2 py-1.5 text-xs text-warn">This agent setup terminal executes on the Marshal daemon host, not in your browser. It runs the pinned installed agent command with the advertised terminal setup metadata; it is not a general shell.</p>
          {!terminal && <Button className="mt-3" size="sm" onClick={() => void openTerminal(method.id)} disabled={busy || activationBusy}><ShieldCheck aria-hidden />Open setup terminal</Button>}
          {terminal && terminal.operation.method_id === method.id && <div className="mt-3">
            <div className="mb-2 flex items-center justify-between text-xs"><span>{terminal.phase === "running" ? "Connected to setup" : terminal.phase === "reprobing" ? "Checking readiness…" : `Setup ${terminal.operation.status}`}</span><span className="text-muted-foreground">{terminal.host}</span></div>
            <pre className="h-56 overflow-auto whitespace-pre-wrap break-all rounded bg-black p-3 font-mono text-xs text-green-300">{terminal.output || "Waiting for terminal output…"}{terminal.output_truncated ? "\n[older output truncated]" : ""}</pre>
            {terminal.phase === "running" && <form className="mt-2 flex gap-2" onSubmit={(event) => { event.preventDefault(); terminalSocket.current?.send(`${terminalInput}\r`); setTerminalInput(""); }}><Input aria-label="Setup terminal input" autoComplete="off" value={terminalInput} onChange={(event) => setTerminalInput(event.target.value)} placeholder="Type setup input and press Enter" /><Button type="submit" size="sm">Send</Button><Button type="button" variant="outline" size="sm" onClick={() => void cancel.mutateAsync(terminal.operation.id)}>Cancel</Button></form>}
            {terminal.operation.terminal_diagnostic && <p className="mt-2 text-xs text-muted-foreground">{terminal.operation.terminal_diagnostic.message} {terminal.operation.terminal_diagnostic.action}</p>}
          </div>}
        </div>
      ))}
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

      <div className="mt-4 flex flex-col gap-2 border-t border-border/80 pt-3 sm:flex-row sm:items-center">
        {cardState === "ready" && <Link href="/chat" className={cn(buttonVariants({ size: "lg" }), "w-full px-4 sm:w-auto")}><MessageSquare aria-hidden />Start chat</Link>}
        {cardState === "sign_in_required" && signInMethod && <Button size="lg" className="w-full px-4 sm:w-auto" onClick={() => onAuthenticate(signInMethod.id)} disabled={busy || activationBusy}><ShieldCheck aria-hidden />Sign in</Button>}
        {cardState === "setup_needed" && <Button size="lg" className="w-full px-4 sm:w-auto" onClick={onProbe} disabled={busy || activationBusy}><Wrench aria-hidden />Retry setup</Button>}
        {cardState === "getting_ready" && <p className="text-sm text-muted-foreground">Setup is running. Details will update when the check finishes.</p>}
      </div>
      </div>

      <details className="group border-t border-border/80 bg-panel/70 text-sm">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-inset/70 hover:text-text [&::-webkit-details-marker]:hidden">
          <span>View details</span>
          <ChevronDown aria-hidden className="size-4 transition-transform group-open:rotate-180" />
        </summary>
        <div className="border-t border-border/80 px-4 py-4">
          <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
            <div><dt className="text-xs text-muted-foreground">Distribution</dt><dd className="mt-0.5 font-medium text-text">{entry.distribution}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Integrity</dt><dd className="mt-0.5 font-medium capitalize text-text">{entry.integrity_status.replaceAll("_", " ")}</dd></div>
            <div><dt className="text-xs text-muted-foreground">ACP protocol</dt><dd className="mt-0.5 font-medium text-text">{entry.protocol_version === null ? "Not negotiated" : `v${entry.protocol_version}`}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Authentication</dt><dd className="mt-0.5 font-medium text-text">{entry.auth_methods.length === 0 ? "No methods advertised" : entry.auth_methods.map((method) => method.name).join(", ")}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Last setup check</dt><dd className="mt-0.5 font-medium text-text">{entry.probed_at ? new Date(entry.probed_at).toLocaleString() : "Not completed"}</dd></div>
          </dl>
          {entry.readiness_failure && <pre className="mt-4 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-bg p-3 font-mono text-[0.6875rem] text-error">{JSON.stringify(entry.readiness_failure, null, 2)}</pre>}
          {(entry.capabilities || entry.raw_initialize) && <details className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground"><summary className="cursor-pointer font-medium hover:text-text">Protocol diagnostics</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-bg p-3 font-mono text-[0.6875rem] text-text">{JSON.stringify({ capabilities: entry.capabilities, raw_initialize: entry.raw_initialize }, null, 2)}</pre></details>}
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
            {entry.readiness_status === "authentication_required" && entry.auth_methods.filter((method) => method.type === "agent").map((method) => <Button key={method.id} variant="outline" size="sm" onClick={() => onAuthenticate(method.id)} disabled={busy || activationBusy}><ShieldCheck aria-hidden />{method.name}</Button>)}
            {entry.auth_methods.map((method) => ({ method, support: authMethodSupport(method) })).filter(({ support }) => !support.supported).map(({ method, support }) => <div key={method.id} className="basis-full rounded border border-warn-border bg-warn-bg px-2 py-1.5 text-xs text-warn"><strong>{method.name}</strong> is advertised but unavailable: {!support.supported && support.reason}</div>)}
            {onUpdate && <Button variant="outline" size="sm" onClick={onUpdate} disabled={busy || preparing}><Download aria-hidden />Update</Button>}
            {entry.status === "installed" && !entry.is_default && <Button variant="outline" size="sm" onClick={() => onDefault(entry.installation_id)} disabled={busy}>Use this version</Button>}
            <Button variant="outline" size="sm" onClick={onProbe} disabled={busy || activationBusy}><Wrench aria-hidden />Retry setup check</Button>
            <Button variant="ghost" size="sm" className="sm:ml-auto text-muted-foreground hover:text-error" onClick={onRemove} disabled={busy || activationBusy}>Remove</Button>
          </div>
        </div>
      </details>
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
          <p className="truncate text-[0.6875rem] text-muted-foreground"><span className="font-mono">{agent.id}</span><span aria-hidden> · </span>{agent.authors[0] ?? "Unknown author"}</p>
        </div>
        <span className="shrink-0 font-mono text-[0.6875rem] text-muted-foreground">v{agent.version}</span>
      </div>
      <p className="mt-3 line-clamp-2 min-h-10 text-sm leading-5 text-muted-foreground">{agent.description}</p>
      <div className="mt-auto flex flex-wrap items-center gap-3 pt-4 text-xs">
        {agent.repository && <a className="inline-flex items-center gap-1 text-primary hover:underline" href={agent.repository} target="_blank" rel="noreferrer">Source <ExternalLink className="size-3" /></a>}
        {agent.website && <a className="inline-flex items-center gap-1 text-primary hover:underline" href={agent.website} target="_blank" rel="noreferrer">Website <ExternalLink className="size-3" /></a>}
        {installed ? (
          <p className="ml-auto flex h-8 items-center gap-1.5 text-sm font-medium text-success"><Check className="size-4" />Installed</p>
        ) : (
          <Button variant="outline" className="ml-auto border-primary/35 text-primary hover:border-primary/60 hover:bg-accent hover:text-primary" onClick={onInstall} disabled={busy || agent.distributions.length === 0 || Boolean(installing) || preparing}>
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

function applyTerminalOutput(current: TerminalAuthSnapshot, payload: unknown): TerminalAuthSnapshot {
  const output = payload && typeof payload === "object" ? payload as { data?: unknown; output_truncated?: unknown; output_limit_bytes?: unknown } : {};
  const data = typeof output.data === "string" ? output.data : "";
  const limit = typeof output.output_limit_bytes === "number" && Number.isSafeInteger(output.output_limit_bytes) && output.output_limit_bytes > 0 ? output.output_limit_bytes : 256 * 1024;
  let combined = current.output + data;
  let locallyTruncated = false;
  while (new TextEncoder().encode(combined).byteLength > limit && combined.length > 0) {
    combined = combined.slice(Math.max(1, Math.floor(combined.length / 8)));
    locallyTruncated = true;
  }
  return { ...current, output: combined, output_truncated: current.output_truncated || Boolean(output.output_truncated) || locallyTruncated };
}
