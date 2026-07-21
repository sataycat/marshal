import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  Agent,
  AgentCommand,
  AgentEvent,
  AgentPromptPart,
  AgentId,
  AgentSession,
  AgentPermissionRequest,
  PromptOptions,
  SpawnOptions,
} from "./types.js";

interface QueueItem {
  event?: AgentEvent;
  terminal?: true;
}

class AsyncQueue {
  private items: QueueItem[] = [];
  private waiters: Array<(item: QueueItem) => void> = [];

  push(item: QueueItem): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }

  next(): Promise<QueueItem> {
    const item = this.items.shift();
    if (item) return Promise.resolve(item);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

interface SessionState {
  process: ChildProcessWithoutNullStreams;
  connection: acp.ClientConnection;
  context: acp.ClientContext;
  sessionId: string;
  closeSupported: boolean;
  permissionMode: NonNullable<SpawnOptions["permissionMode"]>;
  supportsImages: boolean;
  onPermission?: SpawnOptions["onPermission"];
  permissionSequence: number;
  queue: AsyncQueue | null;
  prompting: boolean;
  closed: boolean;
}

export interface SdkAcpAgentAdapterOptions {
  commands: AgentCommand[];
}

export class SdkAcpAgentAdapter implements Agent {
  private readonly commands: Map<AgentId, AgentCommand>;
  private readonly sessions = new Map<AgentSession, SessionState>();

  constructor(options: SdkAcpAgentAdapterOptions) {
    this.commands = new Map(options.commands.map((command) => [command.id, command]));
  }

  async spawn(cwd: string, agentId: AgentId, opts: SpawnOptions = {}): Promise<AgentSession> {
    const command = this.commands.get(agentId);
    if (!command) {
      throw new Error(`No direct ACP command configured for agent "${agentId}"`);
    }

    const child = spawn(command.command, command.args, {
      cwd,
      env: { ...process.env, ...command.env },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    try {
      await waitForSpawn(child, command.command);
      const state = await this.connect(child, cwd, opts);
      const session: AgentSession = {
        agentId,
        cwd,
        name: opts.sessionName ?? `marshal-${agentId}`,
        recordId: state.sessionId,
        supportsImages: state.supportsImages,
      };
      this.sessions.set(session, state);
      return session;
    } catch (err) {
      child.kill();
      throw err;
    }
  }

  async *prompt(
    session: AgentSession,
    prompt: string | AgentPromptPart[],
    opts: PromptOptions = {},
  ): AsyncIterable<AgentEvent> {
    const state = this.getState(session);
    if (state.prompting) throw new Error(`ACP session "${session.name}" is already prompting`);

    state.prompting = true;
    state.permissionMode = opts.permissionMode ?? state.permissionMode;
    state.onPermission = opts.onPermission ?? state.onPermission;
    const queue = new AsyncQueue();
    state.queue = queue;
    let timedOut = false;
    const timeoutSeconds = opts.timeoutSeconds ?? 1800;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      void state.context.notify(acp.methods.agent.session.cancel, { sessionId: state.sessionId });
      queue.push({ event: { type: "done", stopReason: "timeout" } });
      queue.push({ event: { type: "error", message: "timeout", code: 3 } });
      queue.push({ terminal: true });
    }, timeoutSeconds * 1000);

    void state.context
      .request(
        acp.methods.agent.session.prompt,
        { sessionId: state.sessionId, prompt: toAcpPrompt(prompt) },
        { cancellationSignal: controller.signal },
      )
      .then((response) => {
        if (!timedOut) {
          queue.push({ event: { type: "done", stopReason: response.stopReason } });
          queue.push({ terminal: true });
        }
      })
      .catch((err: unknown) => {
        if (!timedOut) {
          queue.push({ event: { type: "error", message: errorMessage(err) } });
          queue.push({ terminal: true });
        }
      });

    try {
      for (;;) {
        const item = await queue.next();
        if (item.terminal) break;
        if (item.event) yield item.event;
      }
    } finally {
      clearTimeout(timer);
      state.queue = null;
      state.prompting = false;
    }
  }

  async cancel(session: AgentSession): Promise<void> {
    const state = this.getState(session);
    await state.context.notify(acp.methods.agent.session.cancel, { sessionId: state.sessionId });
  }

  async close(session: AgentSession): Promise<void> {
    const state = this.sessions.get(session);
    if (!state || state.closed) return;
    state.closed = true;
    try {
      if (state.closeSupported) {
        await state.context.request(acp.methods.agent.session.close, {
          sessionId: state.sessionId,
        });
      }
    } finally {
      state.connection.close();
      state.process.kill();
      await waitForExit(state.process);
      this.sessions.delete(session);
    }
  }

  private async connect(
    child: ChildProcessWithoutNullStreams,
    cwd: string,
    opts: SpawnOptions,
  ): Promise<SessionState> {
    let state: SessionState | undefined;
    const app = acp
      .client({ name: "marshal" })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
        if (!state) return { outcome: { outcome: "cancelled" } };
        if (state.permissionMode === "interactive") {
          const request: AgentPermissionRequest = {
            requestId: `${state.sessionId}:${++state.permissionSequence}`,
            sessionId: state.sessionId,
            tool: params.toolCall.title ?? "tool",
            kind: params.toolCall.kind,
            rawInput: params.toolCall.rawInput,
            options: params.options.map((option) => ({ optionId: option.optionId, name: option.name, kind: option.kind })),
          };
          state.queue?.push({ event: { type: "permission", tool: request.tool, granted: false, requestId: request.requestId } });
          return (async () => {
            const optionId = await state?.onPermission?.(request);
            const option = params.options.find((candidate) => candidate.optionId === optionId);
            return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
          })();
        }
        const option = selectPermissionOption(
          params.options,
          state.permissionMode,
          params.toolCall.kind,
        );
        const granted = option?.kind.startsWith("allow") ?? false;
        state.queue?.push({
          event: { type: "permission", tool: params.toolCall.title ?? "tool", granted },
        });
        return option
          ? { outcome: { outcome: "selected", optionId: option.optionId } }
          : { outcome: { outcome: "cancelled" } };
      })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        if (state && params.sessionId === state.sessionId) {
          const event = mapSessionUpdate(params.update);
          if (event) state.queue?.push({ event });
        }
      });

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const connection = app.connect(stream);
    const context = connection.agent;
    const initialized = await context.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "marshal", version: "0.0.1" },
    });
    if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
      connection.close();
      throw new Error(
        `ACP protocol mismatch: agent selected ${initialized.protocolVersion}, Marshal supports ${acp.PROTOCOL_VERSION}`,
      );
    }
    const created = await context.request(acp.methods.agent.session.new, {
      cwd,
      mcpServers: [],
    });
    state = {
      process: child,
      connection,
      context,
      sessionId: created.sessionId,
      closeSupported: initialized.agentCapabilities?.sessionCapabilities?.close != null,
      permissionMode: opts.permissionMode ?? "approve-all",
      supportsImages: initialized.agentCapabilities?.promptCapabilities?.image === true,
      onPermission: opts.onPermission,
      permissionSequence: 0,
      queue: null,
      prompting: false,
      closed: false,
    };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line) state?.queue?.push({ event: { type: "log", stream: "stderr", text: line } });
      }
    });
    child.on("exit", (code, signal) => {
      if (!state || state.closed || !state.prompting) return;
      state.queue?.push({
        event: {
          type: "error",
          message: `ACP agent exited before prompt completion (${signal ?? `code ${code ?? "unknown"}`})`,
          ...(code === null ? {} : { code }),
        },
      });
      state.queue?.push({ terminal: true });
    });
    return state;
  }

  private getState(session: AgentSession): SessionState {
    const state = this.sessions.get(session);
    if (!state || state.closed) throw new Error(`Unknown or closed ACP session "${session.name}"`);
    return state;
  }
}

function toAcpPrompt(prompt: string | AgentPromptPart[]): acp.ContentBlock[] {
  if (typeof prompt === "string") return [{ type: "text", text: prompt }];
  return prompt.map((part) => part.type === "text"
    ? { type: "text", text: part.text }
    : { type: "image", data: part.data, mimeType: part.mimeType });
}

function waitForSpawn(child: ChildProcessWithoutNullStreams, command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") reject(new Error(`ACP agent command not found: ${command}`));
      else reject(new Error(`Failed to start ACP agent command "${command}": ${err.message}`));
    });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve();
    }, 1000);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", onExit);
  });
}

function selectPermissionOption(
  options: acp.PermissionOption[],
  mode: NonNullable<SpawnOptions["permissionMode"]>,
  toolKind?: acp.ToolKind | null,
): acp.PermissionOption | undefined {
  const readOnly = toolKind && ["read", "search", "fetch", "think"].includes(toolKind);
  const allow = mode === "approve-all" || (mode === "approve-reads" && readOnly);
  const kinds: acp.PermissionOptionKind[] = allow
    ? ["allow_always", "allow_once"]
    : ["reject_always", "reject_once"];
  return kinds.map((kind) => options.find((option) => option.kind === kind)).find(Boolean);
}

function mapSessionUpdate(update: acp.SessionUpdate): AgentEvent | null {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return update.content.type === "text" ? { type: "text", text: update.content.text } : null;
    case "agent_thought_chunk":
      return update.content.type === "text"
        ? { type: "thinking", text: update.content.text }
        : null;
    case "tool_call":
      return {
        type: "tool",
        title: update.title,
        status: update.status,
        output: stringifyOutput(update.rawOutput ?? update.content),
      };
    case "tool_call_update":
      return {
        type: "tool",
        title: update.title ?? `Tool ${update.toolCallId}`,
        status: update.status ?? undefined,
        output: stringifyOutput(update.rawOutput ?? update.content),
      };
    default:
      return {
        type: "log",
        stream: "stdout",
        text: JSON.stringify(update),
      };
  }
}

function stringifyOutput(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
