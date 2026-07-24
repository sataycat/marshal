import * as pty from "node-pty";
import type { IPty } from "node-pty";
import { rmSync } from "node:fs";
import type { WebSocket } from "ws";
import { activateInstalledAgent } from "../agents/activation.js";
import { launchWithResolvedEnvironment } from "../agents/launch-environment.js";
import { finishAgentAuthentication, getAgentAuthenticationOperation, getInstalledAgent, updateTerminalAuthentication } from "../agents/store.js";
import type { AgentAuthenticationOperation, AgentAuthMethod, InstalledAgent } from "../agents/types.js";
import type { EventBus } from "../daemon/bus.js";
import { getGlobalDir } from "../daemon/config.js";
import { createStorageTemporaryDirectory, assertTemporaryPath } from "../storage/layout.js";

export const TERMINAL_AUTH_MAX_INPUT_BYTES = 8 * 1024;
export const TERMINAL_AUTH_MAX_OUTPUT_BYTES = 256 * 1024;
export const TERMINAL_AUTH_MAX_OUTPUT_FRAME_BYTES = 16 * 1024;
const TERMINAL_AUTH_MAX_OUTPUT_FRAME_DATA_BYTES = 2 * 1024;
export const TERMINAL_AUTH_RUNTIME_MS = 15 * 60 * 1000;
export const TERMINAL_AUTH_IDLE_MS = 5 * 60 * 1000;

export interface TerminalAuthSnapshot {
  operation: AgentAuthenticationOperation;
  phase: "running" | "reprobing" | "completed";
  output: string;
  output_truncated: boolean;
  connected: boolean;
  host: string;
}

interface LiveTerminal {
  operationId: string;
  process: IPty;
  workspace: string;
  output: Buffer;
  truncated: boolean;
  phase: TerminalAuthSnapshot["phase"];
  sockets: Set<WebSocket>;
  runtimeTimer: NodeJS.Timeout;
  idleTimer: NodeJS.Timeout;
  settled: boolean;
}

export interface TerminalAuthManagerOptions {
  machineDir?: string;
  bus?: EventBus;
  runtimeMs?: number;
  idleMs?: number;
  maxOutputBytes?: number;
  spawnPty?: typeof pty.spawn;
  activate?: typeof activateInstalledAgent;
  retainMs?: number;
}

export class TerminalAuthManager {
  private readonly live = new Map<string, LiveTerminal>();
  private readonly machineDir?: string;
  private readonly bus?: EventBus;
  private readonly runtimeMs: number;
  private readonly idleMs: number;
  private readonly maxOutputBytes: number;
  private readonly spawnPty: typeof pty.spawn;
  private readonly activate: typeof activateInstalledAgent;
  private readonly retainMs: number;
  private readonly retained = new Map<string, { output: Buffer; truncated: boolean; expires: NodeJS.Timeout }>();

  constructor(options: TerminalAuthManagerOptions = {}) {
    this.machineDir = options.machineDir;
    this.bus = options.bus;
    this.runtimeMs = options.runtimeMs ?? TERMINAL_AUTH_RUNTIME_MS;
    this.idleMs = options.idleMs ?? TERMINAL_AUTH_IDLE_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? TERMINAL_AUTH_MAX_OUTPUT_BYTES;
    this.spawnPty = options.spawnPty ?? pty.spawn;
    this.activate = options.activate ?? activateInstalledAgent;
    this.retainMs = options.retainMs ?? 5 * 60 * 1000;
  }

  start(operation: AgentAuthenticationOperation, installation: InstalledAgent, method: AgentAuthMethod): TerminalAuthSnapshot {
    if (method.type !== "terminal") throw new Error("Only advertised terminal authentication methods can start a setup terminal");
    if (operation.agent_id !== installation.id || operation.version !== installation.version || operation.installation_id !== installation.installation_id || operation.method_id !== method.id) throw new Error("Terminal authentication identity mismatch");
    const workspace = createStorageTemporaryDirectory("terminal-auth", this.machineDir);
    const launch = launchWithResolvedEnvironment(installation, this.machineDir, { additionalEnv: method.env });
    let process: IPty;
    try {
      process = this.spawnPty(launch.command, [...launch.args, ...method.args], {
        cwd: workspace,
        env: launch.env ?? {},
        name: "xterm-256color",
        cols: 100,
        rows: 30,
      });
    } catch (error) {
      rmSync(assertTemporaryPath(this.machineDir ?? getGlobalDir(), workspace), { recursive: true, force: true });
      const message = error instanceof Error ? error.message : String(error);
      finishAgentAuthentication(operation.id, "failed", message, this.machineDir, { kind: "process_start_failed", message, protocol_code: null, data: null });
      updateTerminalAuthentication(operation.id, { diagnostic: { code: "terminal_start_failed", message: "The agent setup terminal could not be started.", action: "Review the installed command and retry setup." } }, this.machineDir);
      throw error;
    }
    const terminal = {} as LiveTerminal;
    Object.assign(terminal, {
      operationId: operation.id,
      process,
      workspace,
      output: Buffer.alloc(0),
      truncated: false,
      phase: "running",
      sockets: new Set<WebSocket>(),
      runtimeTimer: setTimeout(() => this.stop(operation.id, "failed", "Terminal setup exceeded its maximum runtime", "terminal_runtime_timeout"), this.runtimeMs),
      idleTimer: setTimeout(() => this.stop(operation.id, "failed", "Terminal setup was idle for too long", "terminal_idle_timeout"), this.idleMs),
      settled: false,
    });
    terminal.runtimeTimer.unref();
    terminal.idleTimer.unref();
    process.onData((data) => this.onOutput(terminal, data));
    process.onExit(({ exitCode, signal }) => void this.onExit(terminal, exitCode, signal ?? 0));
    this.live.set(operation.id, terminal);
    updateTerminalAuthentication(operation.id, { lastActivityAt: new Date().toISOString() }, this.machineDir);
    return this.snapshot(operation.id)!;
  }

  snapshot(operationId: string): TerminalAuthSnapshot | undefined {
    const operation = getAgentAuthenticationOperation(operationId, this.machineDir);
    if (!operation || operation.method_type !== "terminal") return undefined;
    const terminal = this.live.get(operationId);
    return {
      operation,
      phase: terminal?.phase ?? "completed",
      output: terminal?.output.toString("utf8") ?? this.retained.get(operationId)?.output.toString("utf8") ?? "",
      output_truncated: terminal?.truncated ?? this.retained.get(operationId)?.truncated ?? operation.terminal_output_truncated,
      connected: (terminal?.sockets.size ?? 0) > 0,
      host: process.env.HOSTNAME ?? "Marshal daemon host",
    };
  }

  attach(operationId: string, socket: WebSocket): boolean {
    const operation = getAgentAuthenticationOperation(operationId, this.machineDir);
    const terminal = this.live.get(operationId);
    if (!operation || operation.method_type !== "terminal" || operation.status !== "authenticating" || !terminal || terminal.settled) return false;
    terminal.sockets.add(socket);
    this.send(socket, { type: "terminal.snapshot", payload: this.snapshot(operationId) });
    socket.on("message", (data, binary) => {
      if (binary || Buffer.byteLength(data.toString()) > TERMINAL_AUTH_MAX_INPUT_BYTES) return this.rejectInput(socket, "Terminal input must be a JSON text message no larger than 8 KiB");
      let message: unknown;
      try { message = JSON.parse(data.toString()); } catch { return this.rejectInput(socket, "Malformed terminal input message"); }
      if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== "terminal.input" || typeof (message as { data?: unknown }).data !== "string") return this.rejectInput(socket, "Malformed terminal input message");
      const input = (message as { data: string }).data;
      if (Buffer.byteLength(input) > TERMINAL_AUTH_MAX_INPUT_BYTES) return this.rejectInput(socket, "Terminal input exceeds 8 KiB");
      this.touch(terminal);
      try { terminal.process.write(input); } catch { this.rejectInput(socket, "Terminal input could not be delivered"); }
    });
    const detach = (): void => { terminal.sockets.delete(socket); };
    socket.once("close", detach);
    socket.once("error", detach);
    return true;
  }

  cancel(operationId: string): AgentAuthenticationOperation | undefined {
    const operation = getAgentAuthenticationOperation(operationId, this.machineDir);
    if (!operation || operation.method_type !== "terminal" || operation.status !== "authenticating" || !this.live.has(operationId)) return undefined;
    this.stop(operationId, "cancelled", "Terminal setup was cancelled", "terminal_cancelled");
    return getAgentAuthenticationOperation(operationId, this.machineDir);
  }

  async close(): Promise<void> {
    for (const id of [...this.live.keys()]) this.stop(id, "interrupted", "Terminal setup was interrupted by daemon shutdown", "terminal_daemon_shutdown");
    for (const retained of this.retained.values()) clearTimeout(retained.expires);
    this.retained.clear();
  }

  private onOutput(terminal: LiveTerminal, data: string): void {
    if (terminal.settled) return;
    this.touch(terminal);
    const incoming = boundedUtf8Tail(data, this.maxOutputBytes);
    const combinedBytes = terminal.output.length + incoming.buffer.length;
    terminal.output = boundedUtf8Tail(terminal.output.toString("utf8") + incoming.text, this.maxOutputBytes).buffer;
    if (incoming.truncated || combinedBytes > this.maxOutputBytes) {
      terminal.truncated = true;
      updateTerminalAuthentication(terminal.operationId, { outputTruncated: true }, this.machineDir);
    }
    for (const chunk of utf8Chunks(incoming.text, Math.min(TERMINAL_AUTH_MAX_OUTPUT_FRAME_DATA_BYTES, this.maxOutputBytes))) {
      this.broadcastOutput(terminal, chunk);
    }
  }

  private async onExit(terminal: LiveTerminal, exitCode: number, signal: number): Promise<void> {
    if (terminal.settled) return;
    terminal.settled = true;
    clearTimeout(terminal.runtimeTimer);
    clearTimeout(terminal.idleTimer);
    updateTerminalAuthentication(terminal.operationId, { exitCode, signal, outputTruncated: terminal.truncated, lastActivityAt: new Date().toISOString() }, this.machineDir);
    if (exitCode !== 0) {
      this.finish(terminal, "failed", `Agent setup terminal exited with code ${exitCode}${signal ? ` (signal ${signal})` : ""}`, "terminal_exit_failed", "The setup program did not complete successfully. Review its live output and retry.");
      return;
    }
    terminal.phase = "reprobing";
    this.broadcast(terminal, { type: "terminal.state", payload: this.snapshot(terminal.operationId) });
    const operation = getAgentAuthenticationOperation(terminal.operationId, this.machineDir)!;
    try {
      const refreshed = await this.activate(operation.agent_id, operation.version, this.machineDir, this.bus, undefined, operation.installation_id);
      if (refreshed.readiness_status === "ready") this.finish(terminal, "succeeded", null, "terminal_ready", "Setup completed and the agent is ready.");
      else this.finish(terminal, "failed", refreshed.readiness_error ?? "The agent is still not ready after terminal setup", "terminal_reprobe_not_ready", "Setup exited successfully, but the fresh readiness check did not succeed. Continue sign-in/setup and retry.", refreshed.readiness_failure);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.finish(terminal, "failed", message, "terminal_reprobe_failed", "Setup exited successfully, but Marshal could not complete the fresh readiness check.");
    }
  }

  private finish(terminal: LiveTerminal, status: "succeeded" | "failed" | "cancelled" | "interrupted", error: string | null, code: string, action: string, failure: AgentAuthenticationOperation["failure"] = null): void {
    terminal.settled = true;
    terminal.phase = "completed";
    clearTimeout(terminal.runtimeTimer);
    clearTimeout(terminal.idleTimer);
    finishAgentAuthentication(terminal.operationId, status, error, this.machineDir, failure);
    updateTerminalAuthentication(terminal.operationId, { outputTruncated: terminal.truncated, lastActivityAt: new Date().toISOString(), diagnostic: { code, message: error ?? "Terminal setup completed", action } }, this.machineDir);
    this.broadcast(terminal, { type: "terminal.state", payload: this.snapshot(terminal.operationId) });
    for (const socket of terminal.sockets) try { socket.close(1000, "Terminal operation completed"); } catch { /* ignore */ }
    terminal.sockets.clear();
    const previous = this.retained.get(terminal.operationId);
    if (previous) clearTimeout(previous.expires);
    const expires = setTimeout(() => this.retained.delete(terminal.operationId), this.retainMs);
    expires.unref();
    this.retained.set(terminal.operationId, { output: terminal.output, truncated: terminal.truncated, expires });
    rmSync(assertTemporaryPath(this.machineDir ?? getGlobalDir(), terminal.workspace), { recursive: true, force: true });
    this.live.delete(terminal.operationId);
  }

  private stop(operationId: string, status: "failed" | "cancelled" | "interrupted", message: string, code: string): void {
    const terminal = this.live.get(operationId);
    if (!terminal || terminal.settled) return;
    terminal.settled = true;
    try { terminal.process.kill("SIGTERM"); } catch { /* already exited */ }
    setTimeout(() => { try { terminal.process.kill("SIGKILL"); } catch { /* already exited */ } }, 1000).unref();
    this.finish(terminal, status, message, code, status === "cancelled" ? "Start setup again when ready." : "Retry terminal setup.", { kind: status === "failed" ? "timeout" : "cancelled", message, protocol_code: null, data: null });
  }

  private touch(terminal: LiveTerminal): void {
    clearTimeout(terminal.idleTimer);
    terminal.idleTimer = setTimeout(() => this.stop(terminal.operationId, "failed", "Terminal setup was idle for too long", "terminal_idle_timeout"), this.idleMs);
    terminal.idleTimer.unref();
    updateTerminalAuthentication(terminal.operationId, { lastActivityAt: new Date().toISOString() }, this.machineDir);
  }

  private broadcast(terminal: LiveTerminal, message: unknown): void { for (const socket of terminal.sockets) this.send(socket, message); }
  private broadcastOutput(terminal: LiveTerminal, data: string): void {
    const message = { type: "terminal.output", payload: { operation_id: terminal.operationId, data, output_truncated: terminal.truncated, output_limit_bytes: this.maxOutputBytes } };
    const serialized = JSON.stringify(message);
    if (Buffer.byteLength(serialized) <= TERMINAL_AUTH_MAX_OUTPUT_FRAME_BYTES) {
      for (const socket of terminal.sockets) this.sendSerialized(socket, serialized);
      return;
    }
    const midpoint = codePointMidpoint(data);
    if (midpoint <= 0 || midpoint >= data.length) throw new Error("Terminal output frame could not be bounded");
    this.broadcastOutput(terminal, data.slice(0, midpoint));
    this.broadcastOutput(terminal, data.slice(midpoint));
  }
  private send(socket: WebSocket, message: unknown): void { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message)); }
  private sendSerialized(socket: WebSocket, message: string): void { if (socket.readyState === socket.OPEN) socket.send(message); }
  private rejectInput(socket: WebSocket, message: string): void { this.send(socket, { type: "terminal.error", payload: { code: "terminal_input_invalid", message } }); }
}

function boundedUtf8Tail(value: string, maxBytes: number): { text: string; buffer: Buffer; truncated: boolean } {
  if (maxBytes <= 0 || value.length === 0) return { text: "", buffer: Buffer.alloc(0), truncated: value.length > 0 };
  let start = value.length;
  let bytes = 0;
  while (start > 0) {
    let next = start - 1;
    const code = value.charCodeAt(next);
    if (code >= 0xdc00 && code <= 0xdfff && next > 0) {
      const high = value.charCodeAt(next - 1);
      if (high >= 0xd800 && high <= 0xdbff) next -= 1;
    }
    const size = Buffer.byteLength(value.slice(next, start));
    if (bytes + size > maxBytes) break;
    bytes += size;
    start = next;
  }
  const text = value.slice(start);
  return { text, buffer: Buffer.from(text), truncated: start > 0 };
}

function utf8Chunks(value: string, maxBytes: number): string[] {
  if (!value || maxBytes <= 0) return [];
  const chunks: string[] = [];
  let start = 0;
  let cursor = 0;
  let bytes = 0;
  while (cursor < value.length) {
    const codePoint = value.codePointAt(cursor)!;
    const width = codePoint > 0xffff ? 2 : 1;
    const size = Buffer.byteLength(value.slice(cursor, cursor + width));
    if (bytes > 0 && bytes + size > maxBytes) {
      chunks.push(value.slice(start, cursor));
      start = cursor;
      bytes = 0;
    }
    bytes += size;
    cursor += width;
  }
  if (start < value.length) chunks.push(value.slice(start));
  return chunks;
}

function codePointMidpoint(value: string): number {
  let midpoint = Math.floor(value.length / 2);
  if (midpoint > 0 && midpoint < value.length) {
    const code = value.charCodeAt(midpoint);
    const previous = value.charCodeAt(midpoint - 1);
    if (code >= 0xdc00 && code <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) midpoint -= 1;
  }
  return midpoint;
}
