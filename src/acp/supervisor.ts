import type {
  Agent,
  AgentEvent,
  AgentPromptPart,
  AgentSession,
  AgentPermissionRequest,
  AgentSessionConfigOption,
  AgentSessionModeState,
  SpawnOptions,
} from "../agent/types.js";
import {
  createPrompt,
  createSession,
  appendEvent,
  getSession,
  interruptActiveSessions,
  listSessionEvents,
  listSessions,
  updatePrompt,
  updateSession,
  type AcpSessionRecord,
  type AcpPromptRecord,
} from "./supervisor-store.js";
import {
  createPermissionRequest,
  getPermissionRequestByRequestId,
  getPermissionRequestForThread,
  listPermissionRequests,
  reconcilePermissionRequests,
  resolvePermissionRequest,
  type PermissionRequestRecord,
} from "./permission-store.js";
import { getInstalledAgent, resolveInstalledAgentLaunch } from "../agents/store.js";
import { launchWithResolvedEnvironment } from "../agents/launch-environment.js";
import { SdkAcpAgentAdapter } from "../agent/sdk-adapter.js";
import type { EventBus } from "../daemon/bus.js";
import type { PermissionPolicy } from "../workflows/types.js";
import type { HistoricalAgentProvenance } from "../agents/provenance.js";
import { StructuredAcpFailureError, structuredAcpError } from "./errors.js";

export interface SupervisorOptions {
  root?: string;
  machineDir?: string;
  bus?: EventBus;
  agent?: Agent;
  permissionPolicy?: PermissionPolicy;
  workflow?: boolean;
  permissionMode?: SpawnOptions["permissionMode"];
  onEvent?: (session: AcpSessionRecord, event: AgentEvent) => void;
  onPermission?: (request: PermissionRequestRecord) => void;
  onSessionConfiguration?: (
    session: AcpSessionRecord,
    configuration: {
      configOptions: AgentSessionConfigOption[];
      modes: AgentSessionModeState | null;
    },
  ) => void;
}
interface Runtime {
  record: AcpSessionRecord;
  session: AgentSession;
  agent: Agent;
  prompt?: AcpPromptRecord;
}
export class AcpSessionSupervisor {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly options: SupervisorOptions;
  constructor(options: SupervisorOptions = {}) {
    this.options = options;
    if (options.root) interruptActiveSessions(options.root);
  }
  reconcile(): void {
    for (const record of listSessions(this.options.root))
      if (
        record.status === "interrupted" &&
        record.recovery_metadata &&
        typeof record.recovery_metadata === "object" &&
        (record.recovery_metadata as { resumable?: boolean }).resumable
      )
        updateSession(record.id, { status: "recoverable" }, this.options.root);
  }
  getSession(id: string): AcpSessionRecord | undefined {
    return getSession(id, this.options.root);
  }
  sessionForOwner(
    ownerType: string,
    ownerId: string,
  ): { record: AcpSessionRecord; session: AgentSession } | undefined {
    for (const runtime of this.runtimes.values())
      if (runtime.record.owner_type === ownerType && runtime.record.owner_id === ownerId)
        return {
          record: getSession(runtime.record.id, this.options.root)!,
          session: runtime.session,
        };
    return undefined;
  }
  events(id: string) {
    return listSessionEvents(id, this.options.root);
  }
  async start(
    ownerType: string,
    ownerId: string,
    cwd: string,
    agentId: string,
    agentVersion: string,
    config: {
      model?: string | null;
      mode?: string | null;
      sessionName?: string;
      agentProvenance?: HistoricalAgentProvenance;
    } = {},
  ): Promise<{ record: AcpSessionRecord; session: AgentSession }> {
    const installed = this.options.agent
      ? null
      : getInstalledAgent(
          agentId,
          agentVersion,
          this.options.machineDir,
          config.agentProvenance?.installation_id ?? undefined,
        );
    const launch = installed
      ? launchWithResolvedEnvironment(installed, this.options.machineDir)
      : this.options.agent
        ? null
        : resolveInstalledAgentLaunch(agentId, agentVersion, this.options.machineDir);
    const agent =
      this.options.agent ??
      new SdkAcpAgentAdapter({
        commands: [{ id: agentId, command: launch!.command, args: launch!.args, env: launch!.env }],
      });
    const record = createSession(
      {
        ownerType,
        ownerId,
        agentId,
        agentVersion,
        agentProvenance: config.agentProvenance,
        recoveryMetadata: { resumable: false },
      },
      this.options.root,
    );
    try {
      const session = await withTimeout(
        agent.spawn(cwd, agentId, {
          permissionMode:
            this.options.permissionMode ?? (this.options.workflow ? "deny-all" : "interactive"),
          model: config.model ?? undefined,
          sessionName: config.sessionName ?? `marshal-${ownerId}`,
          onSessionConfiguration: (configuration) =>
            this.recordConfiguration(record.id, configuration),
        }),
        30_000,
        "ACP session startup timed out",
      );
      const updated = updateSession(
        record.id,
        {
          acp_session_id: session.recordId ?? null,
          status: "idle",
          started_at: new Date().toISOString(),
          capabilities: {
            image: session.supportsImages === true,
            configOptions: session.configOptions ?? [],
            modes: session.modes ?? null,
          },
          recovery_metadata: { resumable: false, session_name: session.name },
        },
        this.options.root,
      );
      this.runtimes.set(record.id, { record: updated, session, agent });
      this.recordConfiguration(record.id, {
        configOptions: session.configOptions ?? [],
        modes: session.modes ?? null,
      });
      return { record: updated, session };
    } catch (err) {
      const failure = structuredAcpError(err);
      updateSession(
        record.id,
        {
          status: failure.kind === "authentication_required" ? "authentication_required" : "failed",
          diagnostic: failure.message,
          failure,
          ended_at: new Date().toISOString(),
        },
        this.options.root,
      );
      throw new StructuredAcpFailureError(failure);
    }
  }
  async setConfigOption(
    id: string,
    configId: string,
    value: string | boolean,
  ): Promise<AgentSessionConfigOption[]> {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new Error(`ACP session is not active: ${id}`);
    if (!runtime.agent.setConfigOption)
      throw new Error("This agent does not support ACP session configuration");
    const configOptions = await runtime.agent.setConfigOption(runtime.session, configId, value);
    this.recordConfiguration(id, { configOptions, modes: runtime.session.modes ?? null });
    return configOptions;
  }
  async setMode(id: string, modeId: string): Promise<AgentSessionModeState | null> {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new Error(`ACP session is not active: ${id}`);
    if (!runtime.agent.setMode) throw new Error("This agent does not support ACP session modes");
    const modes = await runtime.agent.setMode(runtime.session, modeId);
    this.recordConfiguration(id, { configOptions: runtime.session.configOptions ?? [], modes });
    return modes;
  }
  permissions(threadId: string): PermissionRequestRecord[] {
    return listPermissionRequests(threadId, this.options.root);
  }
  decidePermission(
    threadId: string,
    requestId: string,
    action: "approve" | "deny",
  ): PermissionRequestRecord {
    const request = getPermissionRequestForThread(threadId, requestId, this.options.root);
    if (!request) throw new Error("Permission request is stale or unknown");
    if (request.status !== "pending") {
      if (request.decision_action === action) return request;
      throw new Error("Permission request is stale or unknown");
    }
    const kind = action === "approve" ? "allow_once" : "reject_once";
    const option = request.options.find((candidate) => candidate.kind === kind);
    if (!option) throw new Error(`Permission request does not offer ${kind}`);
    return resolvePermissionRequest(
      request.id,
      action === "approve" ? "approved" : "denied",
      option.optionId,
      action,
      null,
      this.options.root,
    );
  }
  async prompt(
    id: string,
    content: string | AgentPromptPart[],
    _legacyPermission?: (request: AgentPermissionRequest) => Promise<string | undefined>,
    onEvent?: (event: AgentEvent) => void,
    durable?: { messageId?: number; resubmissionOf?: string },
  ): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new Error(`ACP session is not active: ${id}`);
    const prompt = createPrompt(id, content, this.options.root, durable);
    runtime.prompt = prompt;
    updateSession(id, { status: "running", failure: null, diagnostic: null }, this.options.root);
    try {
      const onPermission = async (request: AgentPermissionRequest): Promise<string | undefined> => {
        const policy = this.options.permissionPolicy;
        const automatic =
          policy === "reject_all" || (this.options.workflow && policy === "allow_reads_ask_writes")
            ? request.options.find(
                (option) => option.kind === "reject_once" || option.kind === "reject_always",
              )
            : policy === "allow_workspace" || policy === "unattended_allow_all"
              ? request.options.find(
                  (option) => option.kind === "allow_once" || option.kind === "allow_always",
                )
              : undefined;
        if (automatic) return automatic.optionId;
        if (policy === "reject_all" || this.options.workflow) return undefined;
        const threadId = runtime.record.owner_id;
        const record = createPermissionRequest(id, threadId, request, this.options.root);
        this.options.onPermission?.(record);
        this.options.bus?.publish("thread.event", {
          threadId,
          event: { type: "permission-request", request: record },
        });
        return await new Promise<string | undefined>((resolve) => {
          const timer = setInterval(() => {
            const current = getPermissionRequestByRequestId(
              id,
              request.requestId,
              this.options.root,
            );
            if (!current || current.status === "pending") return;
            clearInterval(timer);
            resolve(current.selected_option_id ?? undefined);
          }, 50);
        });
      };
      for await (const event of runtime.agent.prompt(runtime.session, content, {
        permissionMode:
          this.options.permissionMode ?? (this.options.workflow ? "deny-all" : "interactive"),
        onPermission,
      })) {
        const persisted = appendEvent(id, prompt.id, event.type, event, event, this.options.root);
        this.options.onEvent?.(getSession(id, this.options.root)!, event);
        onEvent?.(event);
        void persisted;
        if (event.type === "error")
          throw event.failure
            ? new StructuredAcpFailureError(event.failure)
            : new Error(event.message);
      }
      updatePrompt(
        prompt.id,
        { status: "completed", ended_at: new Date().toISOString() },
        this.options.root,
      );
      updateSession(id, { status: "idle" }, this.options.root);
    } catch (err) {
      const failure = structuredAcpError(err);
      const cancelled = failure.kind === "cancelled";
      const authRequired = failure.kind === "authentication_required";
      reconcilePermissionRequests(
        id,
        cancelled ? "cancelled" : "interrupted",
        failure.message,
        this.options.root,
      );
      updatePrompt(
        prompt.id,
        {
          status: authRequired ? "authentication_required" : cancelled ? "cancelled" : "failed",
          diagnostic: failure.message,
          failure,
          ended_at: new Date().toISOString(),
        },
        this.options.root,
      );
      updateSession(
        id,
        {
          status: authRequired ? "authentication_required" : cancelled ? "cancelled" : "failed",
          diagnostic: failure.message,
          failure,
          ended_at: new Date().toISOString(),
        },
        this.options.root,
      );
      if (authRequired) await this.disposeRuntime(id);
      throw new StructuredAcpFailureError(failure);
    }
  }
  async cancel(id: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    if (runtime.prompt)
      updatePrompt(
        runtime.prompt.id,
        { cancellation_requested_at: new Date().toISOString() },
        this.options.root,
      );
    reconcilePermissionRequests(id, "cancelled", "ACP session cancelled", this.options.root);
    updateSession(id, { status: "cancelling" }, this.options.root);
    await withTimeout(runtime.agent.cancel(runtime.session), 10_000, "ACP cancellation timed out");
  }
  async close(id: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    reconcilePermissionRequests(id, "cancelled", "ACP session closed", this.options.root);
    await withTimeout(runtime.agent.close(runtime.session), 10_000, "ACP shutdown timed out");
    updateSession(id, { status: "closed", ended_at: new Date().toISOString() }, this.options.root);
    this.runtimes.delete(id);
  }
  async shutdown(): Promise<void> {
    await Promise.all([...this.runtimes.keys()].map((id) => this.close(id).catch(() => undefined)));
  }
  private async disposeRuntime(id: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    this.runtimes.delete(id);
    await runtime.agent.close(runtime.session).catch(() => undefined);
  }
  private recordConfiguration(
    id: string,
    configuration: {
      configOptions: AgentSessionConfigOption[];
      modes: AgentSessionModeState | null;
    },
  ): void {
    const current = getSession(id, this.options.root);
    if (!current) return;
    const capabilities =
      current.capabilities && typeof current.capabilities === "object"
        ? (current.capabilities as Record<string, unknown>)
        : {};
    const updated = updateSession(
      id,
      {
        capabilities: {
          ...capabilities,
          configOptions: configuration.configOptions,
          modes: configuration.modes,
        },
      },
      this.options.root,
    );
    const runtime = this.runtimes.get(id);
    if (runtime) runtime.record = updated;
    this.options.onSessionConfiguration?.(updated, configuration);
  }
}
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
