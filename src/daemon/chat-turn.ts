import type { Agent, AgentEvent, AgentPromptPart, AgentSession } from "../agent/types.js";
import { resolve } from "node:path";
import { getInstalledAgent } from "../agents/store.js";
import {
  appendChatMessage,
  getChatThread,
  listChatMessages,
  updateChatMessage,
  updateChatThread,
  type ChatMessage,
} from "../chat/store.js";
import { ThreadEventType, publishThreadMessage, publishThreadUpdated, type EventBus } from "./bus.js";
import { expandChatFileMentions } from "../chat/files.js";
import type { PermissionRequestRecord } from "../acp/permission-store.js";
import { reconcileThreadPermissions } from "../acp/permission-store.js";
import { MAX_ATTACHMENTS_PER_MESSAGE, readChatAttachment } from "../chat/attachments.js";
import { AcpSessionSupervisor } from "../acp/supervisor.js";

export class ChatTurnBusyError extends Error {
  constructor(threadId: string) {
    super(`Chat thread is already processing a message: ${threadId}`);
    this.name = "ChatTurnBusyError";
  }
}

export class ChatAgentUnavailableError extends Error {
  constructor(public readonly code: "agent_not_installed" | "agent_not_ready", message: string) {
    super(message);
    this.name = "ChatAgentUnavailableError";
  }
}

interface ActiveTurn {
  supervisorSessionId: string;
  session: AgentSession;
  prompt: Promise<void>;
}

export interface ChatTurnRunnerOptions {
  root?: string;
  machineDir?: string;
  bus?: EventBus;
  agent?: Agent;
}

export class ChatTurnRunner {
  private readonly root?: string;
  private readonly machineDir?: string;
  private readonly bus?: EventBus;
  private configuredAgent?: Agent;
  private readonly supervisor: AcpSessionSupervisor;
  private readonly active = new Map<string, ActiveTurn>();
  private readonly starting = new Set<string>();
  private readonly touched = new Map<string, Set<string>>();

  constructor(options: ChatTurnRunnerOptions = {}) {
    this.root = options.root;
    this.machineDir = options.machineDir;
    this.bus = options.bus;
    this.configuredAgent = options.agent;
    this.supervisor = new AcpSessionSupervisor({ root: this.root, machineDir: this.machineDir, agent: this.configuredAgent, onEvent: (record, event) => this.publishEvent(record.owner_id, event) });
    if (this.root) this.supervisor.reconcile();
  }

  isActive(threadId: string): boolean {
    return this.active.has(threadId);
  }

  touchedFiles(threadId: string): Set<string> {
    return new Set(this.touched.get(threadId));
  }

  pendingPermissions(threadId: string): PermissionRequestRecord[] {
    return this.supervisor.permissions(threadId);
  }

  decidePermission(threadId: string, requestId: string, action: "approve" | "deny"): PermissionRequestRecord {
    return this.supervisor.decidePermission(threadId, requestId, action);
  }

  async closeThread(threadId: string): Promise<void> {
    reconcileThreadPermissions(threadId, this.root);
    const active = this.active.get(threadId);
    if (active) await this.supervisor.close(active.supervisorSessionId);
  }

  async send(threadId: string, content: string, attachmentIds: string[] = []): Promise<{ userMessage: ChatMessage; assistantMessage: ChatMessage }> {
    const thread = getChatThread(threadId, this.root);
    if (this.active.has(threadId) || this.starting.has(threadId)) throw new ChatTurnBusyError(threadId);
    if (thread.status === "closed") throw new Error(`Chat thread is closed: ${threadId}`);

    if (attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE || new Set(attachmentIds).size !== attachmentIds.length) throw new Error("A message may include at most 8 unique images");
    const attachments = attachmentIds.map((id) => readChatAttachment(threadId, id, this.root));
    const expandedContent = expandChatFileMentions(content, thread.cwd);
    let userMessage: ChatMessage | undefined;

    this.getAgent(threadId);
    this.starting.add(threadId);
    try {
      const existing = this.supervisor.sessionForOwner("thread", threadId);
      let session: AgentSession;
      let supervisorSessionId: string;
      if (existing) {
        session = existing.session;
        supervisorSessionId = existing.record.id;
      } else {
        try {
          const started = await this.supervisor.start("thread", threadId, thread.cwd, thread.agent_id, thread.agent_version);
          session = started.session;
          supervisorSessionId = started.record.id;
        } catch (err) {
          updateChatThread(threadId, { status: "error" }, this.root);
          this.publishThread(threadId);
          throw err;
        }
      }
      if (attachments.length > 0 && !session.supportsImages) throw new Error("This agent does not support ACP image prompts. Remove the images or choose an image-capable agent.");
      const promptParts: AgentPromptPart[] = [{ type: "text", text: expandedContent }];
      for (const { attachment, bytes } of attachments) promptParts.push({ type: "image", data: bytes.toString("base64"), mimeType: attachment.mime_type });
      userMessage = appendChatMessage(threadId, "user", expandedContent, this.root, attachmentIds);
      this.publishMessage(threadId, userMessage);
      this.publishThread(threadId);
      const prompt = this.runPrompt(threadId, supervisorSessionId!, attachments.length === 0 ? expandedContent : promptParts);
      this.active.set(threadId, { supervisorSessionId: supervisorSessionId!, session, prompt });
      await prompt;
    } finally {
      this.starting.delete(threadId);
      this.active.delete(threadId);
    }
    const messages = listChatMessages(threadId, this.root);
    return { userMessage: userMessage!, assistantMessage: messages[messages.length - 1] };
  }

  async cancel(threadId: string): Promise<void> {
    const turn = this.active.get(threadId);
    if (!turn) return;
    await this.supervisor.cancel(turn.supervisorSessionId);
  }

  private async runPrompt(threadId: string, supervisorSessionId: string, content: string | AgentPromptPart[]): Promise<void> {
    let assistant: ChatMessage | undefined;
    let text = "";
    try {
      await this.supervisor.prompt(supervisorSessionId, content, undefined, (event) => {
        if (event.type === "text") {
          text += event.text;
          if (assistant) {
            assistant = updateChatMessage(assistant.id, text, this.root);
          } else {
            assistant = appendChatMessage(threadId, "assistant", text, this.root);
          }
          this.publishMessage(threadId, assistant);
          this.publishThread(threadId);
        }
        if (event.type === "error") throw new Error(event.message);
      });
      if (!assistant) {
        assistant = appendChatMessage(threadId, "assistant", "", this.root);
        this.publishMessage(threadId, assistant);
      }
      updateChatThread(threadId, { status: "active" }, this.root);
      this.publishThread(threadId);
    } catch (err) {
      updateChatThread(threadId, { status: "error" }, this.root);
      this.publishThread(threadId);
      throw err;
    }
  }

  private getAgent(threadId: string): Agent {
    if (this.configuredAgent) return this.configuredAgent;
    const thread = getChatThread(threadId, this.root);
    const installed = getInstalledAgent(thread.agent_id, thread.agent_version, this.machineDir);
    if (!installed || installed.status !== "installed") {
      throw new ChatAgentUnavailableError("agent_not_installed", `Installed agent ${thread.agent_id}@${thread.agent_version} is not available`);
    }
    if (installed.readiness_status !== "ready") {
      throw new ChatAgentUnavailableError("agent_not_ready", `Agent ${thread.agent_id}@${thread.agent_version} is not ready (${installed.readiness_status})`);
    }
    const key = `${installed.id}@${installed.version}`;
    void key;
    return this.configuredAgent!;
  }

  private publishMessage(threadId: string, message: ChatMessage): void {
    if (this.bus) publishThreadMessage(this.bus, threadId, message);
  }

  private publishThread(threadId: string): void {
    if (this.bus) publishThreadUpdated(this.bus, getChatThread(threadId, this.root));
  }

  private publishEvent(threadId: string, event: AgentEvent): void {
    if (event.type === "tool") {
      const thread = getChatThread(threadId, this.root);
      const paths = `${event.title}\n${event.output ?? ""}`.match(/(?:^|\s)([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+|[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+)(?=$|\s)/g) ?? [];
      const set = this.touched.get(threadId) ?? new Set<string>();
      for (const raw of paths) {
        const candidate = raw.trim().replace(/[),.:]+$/, "");
        const absolute = resolve(thread.cwd, candidate);
        if (absolute.startsWith(`${resolve(thread.cwd)}/`)) set.add(candidate.replaceAll("\\", "/"));
      }
      this.touched.set(threadId, set);
    }
    this.bus?.publish(ThreadEventType, { threadId, event });
  }
}
