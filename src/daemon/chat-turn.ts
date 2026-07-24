import type { Agent, AgentEvent, AgentPromptPart, AgentSession } from "../agent/types.js";
import { resolve } from "node:path";
import { getInstalledAgent } from "../agents/store.js";
import {
  appendChatMessage,
  clearChatMessagePromptFailure,
  getChatMessage,
  getChatThread,
  listChatMessages,
  updateChatMessage,
  updateChatThread,
  markChatMessageAuthenticationRequired,
  type ChatMessage,
} from "../chat/store.js";
import {
  ThreadEventType,
  publishThreadMessage,
  publishThreadUpdated,
  type EventBus,
} from "./bus.js";
import { expandChatFileMentions } from "../chat/files.js";
import type { PermissionRequestRecord } from "../acp/permission-store.js";
import { reconcileThreadPermissions } from "../acp/permission-store.js";
import { ChatAttachmentError, MAX_ATTACHMENTS_PER_MESSAGE, readChatAttachment } from "../chat/attachments.js";
import { AcpSessionSupervisor } from "../acp/supervisor.js";
import { structuredAcpError } from "../acp/errors.js";
import type { AgentSessionConfigOption, AgentSessionModeState } from "../agent/types.js";

export class ChatTurnBusyError extends Error {
  constructor(threadId: string) {
    super(`Chat session is already processing a message: ${threadId}`);
    this.name = "ChatTurnBusyError";
  }
}

export class ChatAgentUnavailableError extends Error {
  constructor(
    public readonly code: "agent_not_installed" | "agent_not_ready",
    message: string,
  ) {
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
  repositoryId: string;
  root?: string;
  machineDir?: string;
  bus?: EventBus;
  agent?: Agent;
}

export class ChatTurnRunner {
  private readonly repositoryId: string;
  private readonly root?: string;
  private readonly machineDir?: string;
  private readonly bus?: EventBus;
  private configuredAgent?: Agent;
  private readonly supervisor: AcpSessionSupervisor;
  private readonly active = new Map<string, ActiveTurn>();
  private readonly starting = new Set<string>();
  private readonly touched = new Map<string, Set<string>>();

  constructor(options: ChatTurnRunnerOptions) {
    this.repositoryId = options.repositoryId;
    this.root = options.root;
    this.machineDir = options.machineDir;
    this.bus = options.bus;
    this.configuredAgent = options.agent;
    this.supervisor = new AcpSessionSupervisor({
      repositoryId: this.repositoryId,
      root: this.root,
      machineDir: this.machineDir,
      agent: this.configuredAgent,
      onEvent: (record, event) => this.publishEvent(record.owner_id, event),
      onSessionConfiguration: (record, configuration) =>
        this.persistConfiguration(record.owner_id, configuration),
    });
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

  decidePermission(
    threadId: string,
    requestId: string,
    action: "approve" | "deny",
  ): PermissionRequestRecord {
    return this.supervisor.decidePermission(threadId, requestId, action);
  }

  async closeThread(threadId: string): Promise<void> {
    reconcileThreadPermissions(this.repositoryId, threadId, this.machineDir);
    const active = this.active.get(threadId);
    if (active) await this.supervisor.close(active.supervisorSessionId);
  }

  async initializeThread(threadId: string): Promise<void> {
    await this.ensureSession(threadId);
  }

  async setConfigOption(
    threadId: string,
    configId: string,
    value: string | boolean,
  ): Promise<void> {
    const started = await this.ensureSession(threadId);
    const option = getChatThread(this.repositoryId, threadId, this.machineDir).session_config_options.find(
      (candidate) => candidate.id === configId,
    );
    if (!option) throw new Error(`Unknown ACP session configuration option: ${configId}`);
    if (option.type === "boolean" ? typeof value !== "boolean" : typeof value !== "string")
      throw new Error(`Invalid value for ACP session configuration option: ${configId}`);
    await this.supervisor.setConfigOption(started.record.id, configId, value);
  }

  async setMode(threadId: string, modeId: string): Promise<void> {
    const started = await this.ensureSession(threadId);
    const modes = getChatThread(this.repositoryId, threadId, this.machineDir).session_modes;
    if (!modes?.availableModes.some((mode) => mode.id === modeId))
      throw new Error(`Unknown ACP session mode: ${modeId}`);
    await this.supervisor.setMode(started.record.id, modeId);
  }

  async send(
    threadId: string,
    content: string,
    attachmentIds: string[] = [],
  ): Promise<{ userMessage: ChatMessage; assistantMessage: ChatMessage | null }> {
    const thread = getChatThread(this.repositoryId, threadId, this.machineDir);
    if (this.active.has(threadId) || this.starting.has(threadId))
      throw new ChatTurnBusyError(threadId);
    if (thread.status === "closed") throw new Error(`Chat session is closed: ${threadId}`);
    if (thread.status === "authentication_required")
      throw new Error(
        "Authenticate the installed agent, then explicitly resubmit the preserved prompt before sending another message",
      );

    if (
      attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE ||
      new Set(attachmentIds).size !== attachmentIds.length
    )
      throw new ChatAttachmentError("A message may include at most 8 unique images.", "attachment_limit");
    const attachments = attachmentIds.map((id) => readChatAttachment(this.repositoryId, threadId, id, this.machineDir));
    const expandedContent = expandChatFileMentions(content, thread.cwd);
    const userMessage = appendChatMessage(
      this.repositoryId,
      threadId,
      "user",
      expandedContent,
      attachmentIds,
      this.machineDir,
    );
    this.publishMessage(threadId, userMessage);
    this.publishThread(threadId);

    this.getAgent(threadId);
    this.starting.add(threadId);
    try {
      let session: AgentSession;
      let supervisorSessionId: string;
      try {
        const started = await this.ensureSession(threadId);
        session = started.session;
        supervisorSessionId = started.record.id;
      } catch (err) {
        const failure = structuredAcpError(err);
        if (failure.kind === "authentication_required")
          markChatMessageAuthenticationRequired(this.repositoryId, userMessage.id, failure, this.machineDir);
        updateChatThread(
          this.repositoryId,
          threadId,
          {
            status:
              failure.kind === "authentication_required" ? "authentication_required" : "error",
            failure,
          },
          this.machineDir,
        );
        this.publishThread(threadId);
        throw err;
      }
      if (attachments.length > 0 && !session.supportsImages)
        throw new Error(
          "This agent does not support ACP image prompts. Remove the images or choose an image-capable agent.",
        );
      const promptParts: AgentPromptPart[] = [{ type: "text", text: expandedContent }];
      for (const { attachment, bytes } of attachments)
        promptParts.push({
          type: "image",
          data: bytes.toString("base64"),
          mimeType: attachment.mime_type,
        });
      const prompt = this.runPrompt(
        threadId,
        supervisorSessionId!,
        attachments.length === 0 ? expandedContent : promptParts,
        userMessage.id,
      );
      this.active.set(threadId, { supervisorSessionId: supervisorSessionId!, session, prompt });
      await prompt;
    } finally {
      this.starting.delete(threadId);
      this.active.delete(threadId);
    }
    const messages = listChatMessages(this.repositoryId, threadId, this.machineDir);
    return {
      userMessage,
      assistantMessage:
        [...messages]
          .reverse()
          .find((message) => message.role === "assistant" && message.id > userMessage.id) ?? null,
    };
  }

  async resubmit(
    threadId: string,
    messageId: number,
  ): Promise<{ userMessage: ChatMessage; assistantMessage: ChatMessage | null }> {
    const message = getChatMessage(this.repositoryId, messageId, this.machineDir);
    if (
      !message ||
      message.thread_id !== threadId ||
      message.role !== "user" ||
      message.prompt_status !== "authentication_required"
    )
      throw new Error("Only an authentication-required user message can be resubmitted");
    const thread = getChatThread(this.repositoryId, threadId, this.machineDir);
    if (this.active.has(threadId) || this.starting.has(threadId))
      throw new ChatTurnBusyError(threadId);
    const attachments = message.attachment_ids.map((id) =>
      readChatAttachment(this.repositoryId, threadId, id, this.machineDir),
    );
    this.getAgent(threadId);
    this.starting.add(threadId);
    try {
      const existing = this.supervisor.sessionForOwner("thread", threadId);
      const started =
        existing ??
        (await this.supervisor.start(
          "thread",
          threadId,
          thread.cwd,
          thread.agent_id,
          thread.agent_version,
          { agentProvenance: thread.agent_provenance },
        ));
      if (attachments.length > 0 && !started.session.supportsImages)
        throw new Error(
          "This agent does not support ACP image prompts. Remove the images or choose an image-capable agent.",
        );
      const content: string | AgentPromptPart[] =
        attachments.length === 0
          ? message.content
          : [
              { type: "text", text: message.content },
              ...attachments.map(({ attachment, bytes }) => ({
                type: "image" as const,
                data: bytes.toString("base64"),
                mimeType: attachment.mime_type,
              })),
            ];
      const prompt = this.runPrompt(
        threadId,
        started.record.id,
        content,
        message.id,
        message.id.toString(),
      );
      this.active.set(threadId, {
        supervisorSessionId: started.record.id,
        session: started.session,
        prompt,
      });
      await prompt;
      clearChatMessagePromptFailure(this.repositoryId, message.id, this.machineDir);
      this.publishMessage(threadId, getChatMessage(this.repositoryId, message.id, this.machineDir)!);
    } finally {
      this.starting.delete(threadId);
      this.active.delete(threadId);
    }
    const messages = listChatMessages(this.repositoryId, threadId, this.machineDir);
    return {
      userMessage: getChatMessage(this.repositoryId, message.id, this.machineDir)!,
      assistantMessage:
        [...messages].reverse().find((item) => item.role === "assistant" && item.id > message.id) ??
        null,
    };
  }

  async cancel(threadId: string): Promise<void> {
    const turn = this.active.get(threadId);
    if (!turn) return;
    await this.supervisor.cancel(turn.supervisorSessionId);
  }

  private async runPrompt(
    threadId: string,
    supervisorSessionId: string,
    content: string | AgentPromptPart[],
    messageId: number,
    resubmissionOf?: string,
  ): Promise<void> {
    let assistant: ChatMessage | undefined;
    let text = "";
    try {
      await this.supervisor.prompt(
        supervisorSessionId,
        content,
        undefined,
        (event) => {
          if (event.type === "text") {
            text += event.text;
            if (assistant) {
              assistant = updateChatMessage(this.repositoryId, assistant.id, text, this.machineDir);
            } else {
              assistant = appendChatMessage(this.repositoryId, threadId, "assistant", text, [], this.machineDir);
            }
            this.publishMessage(threadId, assistant);
            this.publishThread(threadId);
          }
        },
        { messageId, resubmissionOf },
      );
      if (!assistant) {
        assistant = appendChatMessage(this.repositoryId, threadId, "assistant", "", [], this.machineDir);
        this.publishMessage(threadId, assistant);
      }
      updateChatThread(this.repositoryId, threadId, { status: "active", failure: null }, this.machineDir);
      this.publishThread(threadId);
    } catch (err) {
      const failure = structuredAcpError(err);
      if (failure.kind === "authentication_required") {
        const message = markChatMessageAuthenticationRequired(this.repositoryId, messageId, failure, this.machineDir);
        this.publishMessage(threadId, message);
      }
      updateChatThread(
        this.repositoryId,
        threadId,
        {
          status: failure.kind === "authentication_required" ? "authentication_required" : "error",
          failure,
        },
        this.machineDir,
      );
      this.publishThread(threadId);
      throw err;
    }
  }

  private getAgent(threadId: string): Agent {
    if (this.configuredAgent) return this.configuredAgent;
    const thread = getChatThread(this.repositoryId, threadId, this.machineDir);
    const installed = getInstalledAgent(
      thread.agent_id,
      thread.agent_version,
      this.machineDir,
      thread.agent_provenance.installation_id ?? undefined,
    );
    if (!installed || installed.status !== "installed") {
      throw new ChatAgentUnavailableError(
        "agent_not_installed",
        `Installed agent ${thread.agent_id}@${thread.agent_version} is not available`,
      );
    }
    if (installed.readiness_status !== "ready") {
      throw new ChatAgentUnavailableError(
        "agent_not_ready",
        `Agent ${thread.agent_id}@${thread.agent_version} is not ready (${installed.readiness_status})`,
      );
    }
    const key = `${installed.id}@${installed.version}`;
    void key;
    return this.configuredAgent!;
  }

  private async ensureSession(threadId: string): Promise<{
    record: import("../acp/supervisor-store.js").AcpSessionRecord;
    session: AgentSession;
  }> {
    const existing = this.supervisor.sessionForOwner("thread", threadId);
    if (existing) return existing;
    const thread = getChatThread(this.repositoryId, threadId, this.machineDir);
    this.getAgent(threadId);
    return this.supervisor.start(
      "thread",
      threadId,
      thread.cwd,
      thread.agent_id,
      thread.agent_version,
      { agentProvenance: thread.agent_provenance },
    );
  }

  private persistConfiguration(
    threadId: string,
    configuration: {
      configOptions: AgentSessionConfigOption[];
      modes: AgentSessionModeState | null;
    },
  ): void {
    updateChatThread(
      this.repositoryId,
      threadId,
      {
        sessionConfigOptions: configuration.configOptions,
        sessionModes: configuration.modes,
        sessionInitialized: true,
      },
      this.machineDir,
    );
    this.publishThread(threadId);
  }

  private publishMessage(threadId: string, message: ChatMessage): void {
    if (this.bus) publishThreadMessage(this.bus, threadId, message);
  }

  private publishThread(threadId: string): void {
    if (this.bus) publishThreadUpdated(this.bus, getChatThread(this.repositoryId, threadId, this.machineDir));
  }

  private publishEvent(threadId: string, event: AgentEvent): void {
    if (event.type === "tool") {
      const thread = getChatThread(this.repositoryId, threadId, this.machineDir);
      const paths =
        `${event.title}\n${event.output ?? ""}`.match(
          /(?:^|\s)([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+|[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+)(?=$|\s)/g,
        ) ?? [];
      const set = this.touched.get(threadId) ?? new Set<string>();
      for (const raw of paths) {
        const candidate = raw.trim().replace(/[),.:]+$/, "");
        const absolute = resolve(thread.cwd, candidate);
        if (absolute.startsWith(`${resolve(thread.cwd)}/`))
          set.add(candidate.replaceAll("\\", "/"));
      }
      this.touched.set(threadId, set);
    }
    this.bus?.publish(ThreadEventType, { repositoryId: this.repositoryId, threadId, event });
  }
}
