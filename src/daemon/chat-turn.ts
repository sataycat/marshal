import type { Agent, AgentEvent, AgentSession } from "../agent/types.js";
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

  constructor(options: ChatTurnRunnerOptions = {}) {
    this.root = options.root;
    this.bus = options.bus;
    this.configuredAgent = options.agent;
  }

  isActive(threadId: string): boolean {
    return this.active.has(threadId);
  }

  async send(threadId: string, content: string): Promise<{ userMessage: ChatMessage; assistantMessage: ChatMessage }> {
    const thread = getChatThread(threadId, this.root);
    if (this.active.has(threadId) || this.starting.has(threadId)) throw new ChatTurnBusyError(threadId);
    if (thread.status === "closed") throw new Error(`Chat thread is closed: ${threadId}`);

    const userMessage = appendChatMessage(threadId, "user", content, this.root);
    this.publishMessage(threadId, userMessage);
    this.publishThread(threadId);

    const agent = this.getAgent();
    let session = this.sessions.get(threadId);
    this.starting.add(threadId);
    try {
      if (!session) {
        try {
          session = await agent.spawn(thread.cwd, thread.agent_id, {
            permissionMode: "approve-all",
            sessionName: `marshal-${thread.id}`,
          });
          this.sessions.set(threadId, session);
        } catch (err) {
          updateChatThread(threadId, { status: "error" }, this.root);
          this.publishThread(threadId);
          throw err;
        }
      }
      const prompt = this.runPrompt(threadId, session, content, agent);
      this.active.set(threadId, { session, prompt });
      await prompt;
    } finally {
      this.starting.delete(threadId);
      this.active.delete(threadId);
    }
    const messages = listChatMessages(threadId, this.root);
    return { userMessage, assistantMessage: messages[messages.length - 1] };
  }

  async cancel(threadId: string): Promise<void> {
    const turn = this.active.get(threadId);
    if (!turn) return;
    await this.getAgent().cancel(turn.session);
  }

  private async runPrompt(threadId: string, session: AgentSession, content: string, agent: Agent): Promise<void> {
    let assistant: ChatMessage | undefined;
    let text = "";
    try {
      for await (const event of agent.prompt(session, content, { permissionMode: "approve-all" })) {
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
    this.bus?.publish(ThreadEventType, { threadId, event });
  }
}
