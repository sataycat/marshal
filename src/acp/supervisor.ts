import type { Agent, AgentEvent, AgentPromptPart, AgentSession, AgentPermissionRequest } from "../agent/types.js";
import { createPrompt, createSession, appendEvent, getSession, interruptActiveSessions, listSessionEvents, listSessions, updatePrompt, updateSession, type AcpSessionRecord, type AcpPromptRecord } from "./supervisor-store.js";
import { getInstalledAgent } from "../agents/store.js";
import { SdkAcpAgentAdapter } from "../agent/sdk-adapter.js";
import type { EventBus } from "../daemon/bus.js";

export interface SupervisorOptions { root?: string; machineDir?: string; bus?: EventBus; agent?: Agent; onEvent?: (session: AcpSessionRecord, event: AgentEvent) => void }
interface Runtime { record: AcpSessionRecord; session: AgentSession; agent: Agent; prompt?: AcpPromptRecord; }
export class AcpSessionSupervisor {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly options: SupervisorOptions;
  constructor(options: SupervisorOptions = {}) { this.options = options; if (options.root) interruptActiveSessions(options.root); }
  reconcile(): void { for (const record of listSessions(this.options.root)) if (record.status === "interrupted" && record.recovery_metadata && typeof record.recovery_metadata === "object" && (record.recovery_metadata as { resumable?: boolean }).resumable) updateSession(record.id, { status: "recoverable" }, this.options.root); }
  getSession(id: string): AcpSessionRecord | undefined { return getSession(id, this.options.root); }
  sessionForOwner(ownerType: string, ownerId: string): { record: AcpSessionRecord; session: AgentSession } | undefined {
    for (const runtime of this.runtimes.values()) if (runtime.record.owner_type === ownerType && runtime.record.owner_id === ownerId) return { record: getSession(runtime.record.id, this.options.root)!, session: runtime.session };
    return undefined;
  }
  events(id: string) { return listSessionEvents(id, this.options.root); }
  async start(ownerType: string, ownerId: string, cwd: string, agentId: string, agentVersion: string): Promise<{ record: AcpSessionRecord; session: AgentSession }> {
    const installed = this.options.agent ? null : getInstalledAgent(agentId, agentVersion, this.options.machineDir);
    if (!this.options.agent && (!installed || installed.status !== "installed")) throw new Error(`Installed agent ${agentId}@${agentVersion} is not available`);
    const agent = this.options.agent ?? new SdkAcpAgentAdapter({ commands: [{ id: installed!.id, command: installed!.launch.command, args: installed!.launch.args }] });
    const record = createSession({ ownerType, ownerId, agentId, agentVersion, recoveryMetadata: { resumable: false } }, this.options.root);
    try {
      const session = await withTimeout(agent.spawn(cwd, agentId, { permissionMode: "interactive", sessionName: `marshal-${ownerId}` }), 30_000, "ACP session startup timed out");
      const updated = updateSession(record.id, { acp_session_id: session.recordId ?? null, status: "idle", started_at: new Date().toISOString(), capabilities: { image: session.supportsImages === true }, recovery_metadata: { resumable: false, session_name: session.name } }, this.options.root);
      this.runtimes.set(record.id, { record: updated, session, agent });
      return { record: updated, session };
    } catch (err) { updateSession(record.id, { status: "failed", diagnostic: errorMessage(err), ended_at: new Date().toISOString() }, this.options.root); throw err; }
  }
  async prompt(id: string, content: string | AgentPromptPart[], onPermission?: (request: AgentPermissionRequest) => Promise<string | undefined>, onEvent?: (event: AgentEvent) => void): Promise<void> {
    const runtime = this.runtimes.get(id); if (!runtime) throw new Error(`ACP session is not active: ${id}`);
    const text = typeof content === "string" ? content : content.map((part) => part.type === "text" ? part.text : "[image]").join("");
    const prompt = createPrompt(id, text, this.options.root); runtime.prompt = prompt; updateSession(id, { status: "running" }, this.options.root);
    try {
      for await (const event of runtime.agent.prompt(runtime.session, content, { permissionMode: "interactive", onPermission })) {
        const persisted = appendEvent(id, prompt.id, event.type, event, event, this.options.root);
        this.options.onEvent?.(getSession(id, this.options.root)!, event);
        onEvent?.(event);
        void persisted;
        if (event.type === "error") throw new Error(event.message);
      }
      updatePrompt(prompt.id, { status: "completed", ended_at: new Date().toISOString() }, this.options.root); updateSession(id, { status: "idle" }, this.options.root);
    } catch (err) { const cancelled = errorMessage(err).toLowerCase().includes("cancel"); updatePrompt(prompt.id, { status: cancelled ? "cancelled" : "failed", diagnostic: errorMessage(err), ended_at: new Date().toISOString() }, this.options.root); updateSession(id, { status: cancelled ? "cancelled" : "failed", diagnostic: errorMessage(err), ended_at: new Date().toISOString() }, this.options.root); throw err; }
  }
  async cancel(id: string): Promise<void> { const runtime = this.runtimes.get(id); if (!runtime) return; if (runtime.prompt) updatePrompt(runtime.prompt.id, { cancellation_requested_at: new Date().toISOString() }, this.options.root); updateSession(id, { status: "cancelling" }, this.options.root); await withTimeout(runtime.agent.cancel(runtime.session), 10_000, "ACP cancellation timed out"); }
  async close(id: string): Promise<void> { const runtime = this.runtimes.get(id); if (!runtime) return; await withTimeout(runtime.agent.close(runtime.session), 10_000, "ACP shutdown timed out"); updateSession(id, { status: "closed", ended_at: new Date().toISOString() }, this.options.root); this.runtimes.delete(id); }
  async shutdown(): Promise<void> { await Promise.all([...this.runtimes.keys()].map((id) => this.close(id).catch(() => undefined))); }
}
function errorMessage(err: unknown): string { return err instanceof Error ? err.message : String(err); }
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> { let timer: NodeJS.Timeout | undefined; try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); } finally { if (timer) clearTimeout(timer); } }
