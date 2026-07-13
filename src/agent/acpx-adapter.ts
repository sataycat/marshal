import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { loadGlobalConfig } from "../worktree/config.js";
import { logger } from "../logger.js";
import type {
  Agent,
  AgentEvent,
  AgentId,
  AgentSession,
  PromptOptions,
  SpawnOptions,
} from "./types.js";

// Removed. ACPX takes the agent id as a positional CLI argument, so the id
// IS the token. There is no registry to consult.

// Acceptance range: the semver range an ALREADY-installed acpx binary must
// satisfy for Marshal to use it. Kept wide within a minor so users who installed
// acpx themselves (e.g. `npm i -g acpx@0.12.3`) are not forced to downgrade.
//
// Per ADR-023 Decision 6, this pin exists because ACPX's CLI grammar, flag
// names, output shapes, and the no-envelope NDJSON stream are now Marshal's
// versioned API contract (acpx.sh/VISION Principle 4) — NOT because we expect
// ACPX to break. A minor-bump warning stays a warning (not a hard fail) so a
// 0.12 → 0.13 bump on a stability-committed CLI is a normal semver transition,
// not an emergency; the daemon logs it loudly so an operator notices before a
// subtle flag rename bites them.
export const DEFAULT_VERSION_RANGE = ">=0.12.0 <0.13.0";

// Install pin: the exact version string Marshal puts in `npm i -g acpx@...`
// install hints when it is the one performing or recommending the install.
// Pinned (not a range) so fresh installs are reproducible; the install path
// is the thing Marshal controls, the accept range is the thing the user controls.
export const ACPX_INSTALL_PIN = "0.12.0";
const DEFAULT_TIMEOUT_SECONDS = 1800;

export interface AcpxAgentAdapterOptions {
  binPath?: string;
  versionRange?: string;
}

interface AcpJsonRpcMessage {
  jsonrpc?: string;
  method?: string;
  params?: Record<string, unknown>;
  id?: number | string;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

export class AcpxAgentAdapter implements Agent {
  private binPath: string;
  private versionRange: string;
  private versionChecked: Promise<void> | null = null;

  constructor(options: AcpxAgentAdapterOptions = {}) {
    this.binPath = options.binPath ?? loadAcpxBinPath();
    this.versionRange = options.versionRange ?? loadAcpxVersionRange();
  }

  private async ensureVersion(): Promise<void> {
    if (this.versionChecked) {
      return this.versionChecked;
    }

    this.versionChecked = this.runVersionCheck();
    return this.versionChecked;
  }

  private async runVersionCheck(): Promise<void> {
    const { code, stdout, stderr } = await runCommand(this.binPath, ["--version"]);
    if (code !== 0) {
      if (stderr.includes("command not found") || stderr.includes("No such file")) {
        throw acpxNotInstalledError();
      }
      throw new Error(`acpx --version failed: ${stderr || stdout}`);
    }

    const version = stdout.trim();
    if (!satisfiesVersionRange(version, this.versionRange)) {
      logger.warn(
        { version, expected: this.versionRange, binPath: this.binPath },
        "ACPX version does not match the expected range",
      );
    }
  }

  async spawn(cwd: string, agentId: AgentId, opts: SpawnOptions = {}): Promise<AgentSession> {
    const name = opts.sessionName ?? defaultSessionName(agentId);

    await this.ensureVersion();

    const args = [
      "--cwd",
      cwd,
      "--format",
      "json",
      "--json-strict",
      agentId,
      "sessions",
      "ensure",
      "--name",
      name,
    ];

    const { code, stdout, stderr } = await runCommand(this.binPath, args);
    if (code !== 0) {
      throw acpxCommandError("sessions ensure", code!, stderr || stdout);
    }

    const record = parseSessionRecord(stdout);
    return {
      agentId,
      cwd,
      name,
      recordId: (record.recordId as string | undefined) ?? (record.id as string | undefined),
    };
  }

  async *prompt(
    session: AgentSession,
    text: string,
    opts: PromptOptions = {},
  ): AsyncGenerator<AgentEvent> {
    await this.ensureVersion();

    const args = buildPromptArgs(session, opts);
    const child = spawn(this.binPath, args, { cwd: session.cwd });

    const events: AgentEvent[] = [];
    let finished = false;
    let spawnError: Error | undefined;
    const resolvers: (() => void)[] = [];

    const push = (event: AgentEvent): void => {
      events.push(event);
      while (resolvers.length > 0) {
        resolvers.shift()?.();
      }
    };

    const finish = (): void => {
      finished = true;
      while (resolvers.length > 0) {
        resolvers.shift()?.();
      }
    };

    const fail = (err: Error): void => {
      spawnError = err;
      finished = true;
      while (resolvers.length > 0) {
        resolvers.shift()?.();
      }
    };

    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        fail(acpxNotInstalledError());
      } else {
        fail(err);
      }
    });

    const stdoutRl = createInterface({ input: child.stdout });
    stdoutRl.on("line", (line) => {
      if (!line.trim()) return;
      for (const event of parseAcpLine(line)) {
        push(event);
      }
    });

    const stderrRl = createInterface({ input: child.stderr });
    stderrRl.on("line", (line) => {
      push({ type: "log", stream: "stderr", text: line });
    });

    let doneEmitted = false;

    child.on("close", (code, signal) => {
      stdoutRl.close();
      stderrRl.close();

      if (!doneEmitted) {
        if (code === 0) {
          push({ type: "done", stopReason: "end_turn" });
        } else if (code === 3) {
          push({ type: "done", stopReason: "timeout" });
          push({ type: "error", message: "timeout", code: 3 });
        } else {
          const mapped = mapExitCode(code, signal);
          push({ type: "error", message: mapped.message, code: mapped.code });
        }
      }
      finish();
    });

    child.stdin.write(text);
    child.stdin.end();

    while (!finished || events.length > 0) {
      if (events.length === 0) {
        await new Promise<void>((resolve, reject) => {
          if (spawnError) {
            reject(spawnError);
            return;
          }
          if (finished && events.length === 0) {
            resolve();
            return;
          }
          resolvers.push(resolve);
        });
      }

      if (events.length > 0) {
        const event = events.shift()!;
        if (event.type === "done") {
          doneEmitted = true;
        }
        yield event;
      }
    }
  }

  async cancel(session: AgentSession): Promise<void> {
    const args = ["--cwd", session.cwd, session.agentId, "cancel", "-s", session.name];
    const { code, stdout, stderr } = await runCommand(this.binPath, args);
    if (code !== 0) {
      throw acpxCommandError("cancel", code!, stderr || stdout);
    }
  }

  async close(session: AgentSession): Promise<void> {
    const args = ["--cwd", session.cwd, session.agentId, "sessions", "close", session.name];
    const { code, stdout, stderr } = await runCommand(this.binPath, args);
    if (code !== 0) {
      throw acpxCommandError("sessions close", code!, stderr || stdout);
    }
  }
}

function defaultSessionName(agentId: AgentId): string {
  return `marshal-${agentId}`;
}

function buildPromptArgs(session: AgentSession, opts: PromptOptions): string[] {
  const args: string[] = ["--cwd", session.cwd, "--format", "json", "--json-strict"];

  const permissionMode = opts.permissionMode ?? "approve-all";
  args.push(`--${permissionMode}`);
  args.push("--non-interactive-permissions", "fail");

  const timeout = opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  args.push("--timeout", String(timeout));

  if (opts.model) {
    args.push("--model", opts.model);
  }

  if (opts.systemPrompt) {
    args.push("--system-prompt", opts.systemPrompt);
  }

  args.push(session.agentId);
  args.push("-s", session.name);

  if (opts.noWait) {
    args.push("--no-wait");
  }

  if (opts.extraArgs) {
    args.push(...opts.extraArgs);
  }

  args.push("--file", "-");
  return args;
}

function acpxNotInstalledError(): Error {
  return new Error(
    "acpx is not installed. Install with `npm i -g acpx@latest` and see docs/adr/archived/ADR-023.md.",
  );
}

function acpxCommandError(command: string, code: number, output: string): Error {
  return new Error(`acpx ${command} failed with code ${code}: ${output.trim()}`);
}

function loadAcpxBinPath(): string {
  const config = loadGlobalConfig();
  return config.acpx?.bin ?? "acpx";
}

function loadAcpxVersionRange(): string {
  const config = loadGlobalConfig();
  return config.acpx?.version ?? DEFAULT_VERSION_RANGE;
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCommand(binPath: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binPath, args);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(acpxNotInstalledError());
      } else {
        reject(err);
      }
    });

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

    child.on("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

function parseSessionRecord(stdout: string): Record<string, unknown> {
  const line = stdout.split("\n").find((l) => l.trim().length > 0);
  if (!line) {
    return {};
  }
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseAcpLine(line: string): AgentEvent[] {
  let msg: AcpJsonRpcMessage;
  try {
    msg = JSON.parse(line) as AcpJsonRpcMessage;
  } catch {
    return [{ type: "log", stream: "stdout", text: line }];
  }

  const events: AgentEvent[] = [];

  if (msg.method === "session/update") {
    const params = msg.params ?? {};
    const update = params.sessionUpdate as string | undefined;
    const content = (params.content ?? {}) as Record<string, unknown>;

    if (update === "agent_message_chunk" && content.type === "text") {
      events.push({ type: "text", text: String(content.text ?? "") });
    } else if (update === "agent_message" && content.type === "text") {
      events.push({ type: "text", text: String(content.text ?? "") });
    } else if (update === "agent_thinking") {
      events.push({ type: "thinking", text: String(content.text ?? params.text ?? "") });
    } else if (update?.startsWith("tool")) {
      events.push({
        type: "tool",
        title: String(content.title ?? content.name ?? content.tool ?? update),
        status: String(content.status ?? update.replace(/^tool_/, "").replace(/_/g, " ")),
        output: content.output != null ? String(content.output) : undefined,
      });
    } else {
      events.push({ type: "log", stream: "stdout", text: line });
    }
  } else if (msg.method === "session/request_permission") {
    const params = msg.params ?? {};
    events.push({
      type: "permission",
      tool: String(params.tool ?? ""),
      granted: true,
    });
  } else if (msg.result) {
    const resultContent = msg.result.content as Record<string, unknown> | undefined;
    if (resultContent?.type === "text") {
      events.push({ type: "text", text: String(resultContent.text) });
    }
    if (msg.result.stopReason) {
      events.push({ type: "done", stopReason: String(msg.result.stopReason) });
    } else {
      events.push({ type: "done", stopReason: "end_turn" });
    }
  } else if (msg.error) {
    events.push({
      type: "error",
      message: String(msg.error.message ?? "ACPX protocol error"),
      code: msg.error.code,
    });
  } else {
    events.push({ type: "log", stream: "stdout", text: line });
  }

  return events;
}

function mapExitCode(
  code: number | null,
  signal: NodeJS.Signals | null,
): { message: string; code: number } {
  if (signal === "SIGINT") {
    return { message: "interrupted", code: 130 };
  }
  switch (code) {
    case 3:
      return { message: "timeout", code: 3 };
    case 4:
      return { message: "no session", code: 4 };
    case 5:
      return { message: "permission denied", code: 5 };
    case 1:
      return { message: "agent error", code: 1 };
    case 2:
      return { message: "acpx usage error", code: 2 };
    default:
      return { message: `acpx exited with code ${code ?? signal ?? "unknown"}`, code: code ?? 1 };
  }
}

function parseVersion(version: string): [number, number, number] {
  const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return [0, 0, 0];
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) {
      return a[i] - b[i];
    }
  }
  return 0;
}

export function satisfiesVersionRange(version: string, range: string): boolean {
  const parsed = parseVersion(version);
  const trimmed = range.trim();

  // Exact version: require full match.
  if (/^\d+\.\d+\.\d+$/.test(trimmed)) {
    return compareVersions(parsed, parseVersion(trimmed)) === 0;
  }

  const tokens = trimmed.split(/\s+/);
  for (const token of tokens) {
    const opMatch = token.match(/^(>=|<=|>||<|=)?(\d+\.\d+\.\d+)$/);
    if (!opMatch) continue;
    const op = opMatch[1] ?? "=";
    const target = parseVersion(opMatch[2]);
    const cmp = compareVersions(parsed, target);
    let ok = false;
    switch (op) {
      case "=":
      case "":
        ok = cmp === 0;
        break;
      case ">":
        ok = cmp > 0;
        break;
      case ">=":
        ok = cmp >= 0;
        break;
      case "<":
        ok = cmp < 0;
        break;
      case "<=":
        ok = cmp <= 0;
        break;
    }
    if (!ok) return false;
  }
  return true;
}
