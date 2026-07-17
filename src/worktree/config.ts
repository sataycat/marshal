import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { logger } from "../logger.js";
import type { AgentCommand, AgentId } from "../agent/types.js";

export type AgentRole = "builder" | "validator" | "specAuthor";

export class MissingAgentIdError extends Error {
  readonly role: AgentRole;
  constructor(role: AgentRole) {
    const key = `agents.${role}`;
    super(
      `No agent configured for role "${role}". Set ~/.marshal/config.json -> ${key} to a direct ACP command.`,
    );
    this.name = "MissingAgentIdError";
    this.role = role;
  }
}

export interface MarshalJson {
  worktree?: {
    setup?: string;
  };
}

export interface GlobalConfig {
  worktree?: {
    root?: string;
  };
  agents?: {
    builder?: AgentConfig;
    validator?: AgentConfig;
    specAuthor?: AgentConfig;
  };
  policy?: {
    maxRetries?: number;
  };
  daemon?: {
    host?: string;
    port?: number;
    uiPassword?: string;
    trustedOrigins?: string[];
  };
}

export type AgentConfig = AgentCommand;

export function loadMarshalJson(repoRoot: string): MarshalJson {
  const path = resolve(repoRoot, "marshal.json");
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as MarshalJson;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    logger.warn({ err, path }, "Failed to parse marshal.json");
    return {};
  }
}

export function loadGlobalConfig(): GlobalConfig {
  const path = process.env.MARSHAL_GLOBAL_CONFIG ?? resolve(homedir(), ".marshal", "config.json");
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as GlobalConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    logger.warn({ err, path }, "Failed to parse ~/.marshal/config.json");
    return {};
  }
}

// `resolveAgentId` has no silent defaults: if a role is missing from the
// config it throws `MissingAgentIdError` at first real use (not at boot),
// so the daemon starts fine without a config and only fails when a task
// actually tries to build/validate/author a spec (ADR-023 Decision 3).
//
// `AGENT_COMMAND_DEFAULTS` is the set of commands `marshal init` writes into a fresh
// `~/.marshal/config.json` so the post-init state is immediately usable
// (ADR-024 Decision 3). It is NOT consulted by `resolveAgentId` — the
// config file is the single source of truth at runtime.
export const AGENT_COMMAND_DEFAULTS: Record<AgentRole, AgentCommand> = {
  builder: { id: "opencode", command: "npx", args: ["-y", "opencode-ai", "acp"] },
  validator: { id: "pi", command: "npx", args: ["-y", "pi-acp"] },
  specAuthor: { id: "opencode", command: "npx", args: ["-y", "opencode-ai", "acp"] },
};

export function isAgentCommand(value: unknown): value is AgentCommand {
  if (typeof value !== "object" || value === null) return false;
  const command = value as Partial<AgentCommand>;
  return (
    typeof command.id === "string" &&
    command.id.length > 0 &&
    typeof command.command === "string" &&
    command.command.length > 0 &&
    Array.isArray(command.args) &&
    command.args.every((arg) => typeof arg === "string") &&
    (command.env === undefined ||
      (typeof command.env === "object" &&
        command.env !== null &&
        Object.values(command.env).every((value) => typeof value === "string")))
  );
}

export function resolveAgentId(
  role: AgentRole,
  config: GlobalConfig = loadGlobalConfig(),
): AgentId {
  const raw = config.agents?.[role];
  if (!raw) {
    throw new MissingAgentIdError(role);
  }
  if (!isAgentCommand(raw)) {
    throw new Error(
      `Invalid agent configuration for role "${role}". String agent IDs are no longer supported; configure agents.${role} with { id, command, args, env? }.`,
    );
  }
  return raw.id;
}

export function resolveAgentCommand(
  role: AgentRole,
  config: GlobalConfig = loadGlobalConfig(),
): AgentCommand {
  const raw = config.agents?.[role];
  if (!raw) {
    throw new MissingAgentIdError(role);
  }
  if (!isAgentCommand(raw)) {
    throw new Error(
      `Invalid agent configuration for role "${role}". String agent IDs are no longer supported; configure agents.${role} with { id, command, args, env? }.`,
    );
  }
  return raw;
}

export const DEFAULT_MAX_RETRIES = 2;

export function resolveMaxRetries(config: GlobalConfig = loadGlobalConfig()): number {
  const raw = config.policy?.maxRetries;
  if (raw === undefined) {
    return DEFAULT_MAX_RETRIES;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    logger.warn({ raw }, "Invalid policy.maxRetries; using default");
    return DEFAULT_MAX_RETRIES;
  }
  return value;
}

export const DEFAULT_DAEMON_HOST = "127.0.0.1";
export const DEFAULT_DAEMON_PORT = 7433;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export interface ResolvedDaemonBind {
  host: string;
  port: number;
}

export function resolveDaemonBind(
  args: { host?: string; port?: number },
  config: GlobalConfig = loadGlobalConfig(),
): ResolvedDaemonBind {
  const host = args.host ?? config.daemon?.host ?? DEFAULT_DAEMON_HOST;
  const rawPort = args.port ?? config.daemon?.port;
  let port = DEFAULT_DAEMON_PORT;
  if (rawPort !== undefined) {
    const n = Number(rawPort);
    // Port 0 is valid and means "ask the OS for a free port" (used by tests and
    // any caller that wants ephemeral binding). Reject only out-of-range ints.
    if (Number.isInteger(n) && n >= 0 && n <= 65535) {
      port = n;
    } else {
      logger.warn({ rawPort }, "Invalid daemon.port; using default");
    }
  }

  return { host, port };
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}
