import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { logger } from "../logger.js";
import type { AgentId } from "../agent/types.js";

export interface MarshalJson {
  worktree?: {
    setup?: string;
  };
}

export interface GlobalConfig {
  worktree?: {
    root?: string;
  };
  acpx?: {
    bin?: string;
    version?: string;
  };
  agents?: {
    builder?: string;
    validator?: string;
  };
  policy?: {
    maxRetries?: number;
  };
  daemon?: {
    host?: string;
    port?: number;
  };
}

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

const VALID_AGENT_IDS: readonly AgentId[] = ["opencode", "pi"] as const;

const AGENT_ID_DEFAULTS: Record<AgentRole, AgentId> = {
  builder: "opencode",
  validator: "pi",
};

export type AgentRole = "builder" | "validator";

export class InvalidAgentIdError extends Error {
  constructor(role: AgentRole, value: string) {
    super(`Invalid agent ID for ${role}: ${value}`);
    this.name = "InvalidAgentIdError";
  }
}

export function resolveAgentId(role: AgentRole, config: GlobalConfig = loadGlobalConfig()): AgentId {
  const raw = config.agents?.[role];
  if (raw === undefined) {
    return AGENT_ID_DEFAULTS[role];
  }
  if ((VALID_AGENT_IDS as readonly string[]).includes(raw)) {
    return raw as AgentId;
  }
  throw new InvalidAgentIdError(role, raw);
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

export function resolveDaemonBind(args: { host?: string; port?: number }, config: GlobalConfig = loadGlobalConfig()): ResolvedDaemonBind {
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

  if (!LOOPBACK_HOSTS.has(host)) {
    logger.warn(
      { host },
      "Binding to a non-loopback address. Daemon API has no auth layer. Expose only via an authenticated tunnel. Continuing because explicitly requested.",
    );
  }

  return { host, port };
}
