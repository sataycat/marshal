import type { Agent, AgentEvent, AgentPromptPart, AgentSession } from "../agent/types.js";
import { resolve } from "node:path";
import { createConfiguredAgent } from "../agent/configured-agent.js";
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
import { PermissionBroker, type PendingPermission } from "./permission-broker.js";
import { MAX_ATTACHMENTS_PER_MESSAGE, readChatAttachment } from "../chat/attachments.js";

export class ChatTurnBusyError extends Error {
  constructor(threadId: string) {
    super(`Chat thread is already processing a message: ${threadId}`);
    this.name = "ChatTurnBusyError";
  }
}

interface ActiveTurn {
  session: AgentSession;
  prompt: Promise<void>;
}

export interface ChatTurnRunnerOptions {
  root?: string;
  bus?: EventBus;
  agent?: Agent;
}

export class ChatTurnRunner {
  private readonly root?: string;
  private readonly bus?: EventBus;
  private configuredAgent?: Agent;
  private readonly sessions = new Map<string, AgentSession>();
  private readonly active = new Map<string, ActiveTurn>();
  private readonly starting = new Set<string>();
  private readonly touched = new Map<string, Set<string>>();
  private readonly permissions: PermissionBroker;

  constructor(options: ChatTurnRunnerOptions = {}) {
    this.root = options.root;
    this.bus = options.bus;
    this.configuredAgent = options.agent;
    this.permissions = new PermissionBroker(this.bus);
  }

  isActive(threadId: string): boolean {
    return this.active.has(threadId);
  }

  touchedFiles(threadId: string): Set<string> {
    return new Set(this.touched.get(threadId));
  }

  pendingPermissions(threadId: string): PendingPermission[] {
    return this.permissions.list(threadId);
  }

  decidePermission(threadId: string, requestId: string, action: "approve" | "deny"): PendingPermission {
    return this.permissions.decide(threadId, requestId, action);
  }

  async closeThread(threadId: string): Promise<void> {
    this.permissions.cancelThread(threadId);
    const session = this.sessions.get(threadId);
    if (session) {
      await this.getAgent().close(session);
      this.sessions.delete(threadId);
    }
  }

  async send(threadId: string, content: string, attachmentIds: string[] = []): Promise<{ userMessage: ChatMessage; assistantMessage: ChatMessage }> {
    const thread = getChatThread(threadId, this.root);
    if (this.active.has(threadId) || this.starting.has(threadId)) throw new ChatTurnBusyError(threadId);
    if (thread.status === "closed") throw new Error(`Chat thread is closed: ${threadId}`);

    if (attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE || new Set(attachmentIds).size !== attachmentIds.length) throw new Error("A message may include at most 8 unique images");
    const attachments = attachmentIds.map((id) => readChatAttachment(threadId, id, this.root));
    const expandedContent = expandChatFileMentions(content, thread.cwd);
    let userMessage: ChatMessage | undefined;

    const agent = this.getAgent();
    let session = this.sessions.get(threadId);
    this.starting.add(threadId);
    try {
      if (!session) {
        try {
          session = await agent.spawn(thread.cwd, thread.agent_id, {
            permissionMode: "interactive",
            sessionName: `marshal-${thread.id}`,
            onPermission: (request) => this.permissions.request(threadId, request),
          });
          this.sessions.set(threadId, session);
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
      const prompt = this.runPrompt(threadId, session, attachments.length === 0 ? expandedContent : promptParts, agent);
      this.active.set(threadId, { session, prompt });
      await prompt;
    } finally {
      this.starting.delete(threadId);
      this.active.delete(threadId);
    }
    const messages = listChatMessages(threadId, this.root);
    return { userMessage: userMessage!, assistantMessage: messages[messages.length - 1] };
  }

  async cancel(threadId: string): Promise<void> {
    this.permissions.cancelThread(threadId);
    const turn = this.active.get(threadId);
    if (!turn) return;
    await this.getAgent().cancel(turn.session);
  }

  private async runPrompt(threadId: string, session: AgentSession, content: string | AgentPromptPart[], agent: Agent): Promise<void> {
    let assistant: ChatMessage | undefined;
    let text = "";
    try {
      for await (const event of agent.prompt(session, content, {
        permissionMode: "interactive",
        onPermission: (request) => this.permissions.request(threadId, request),
      })) {
        this.publishEvent(threadId, event);
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
      }
      if (!assistant) {
        assistant = appendChatMessage(threadId, "assistant", "", this.root);
        this.publishMessage(threadId, assistant);
      }
      updateChatThread(threadId, { status: "active" }, this.root);
      this.publishThread(threadId);
    } catch (err) {
      this.permissions.cancelThread(threadId);
      updateChatThread(threadId, { status: "error" }, this.root);
      this.publishThread(threadId);
      throw err;
    }
  }

  private getAgent(): Agent {
    return (this.configuredAgent ??= createConfiguredAgent("builder"));
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
