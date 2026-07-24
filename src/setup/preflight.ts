import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { SdkAcpAgentAdapter } from "../agent/sdk-adapter.js";
import type { AgentCommand } from "../agent/types.js";
import { getGlobalDir } from "../daemon/config.js";
import {
  DEFAULT_MAX_RETRIES,
  isAgentCommand,
  type AgentRole,
  type GlobalConfig,
} from "../worktree/config.js";

export type CheckStatus = "ok" | "missing" | "warning" | "fail";

export interface CheckResult {
  label: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
  docs?: string;
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  notFound: boolean;
}

export type CommandRunner = (bin: string, args: string[]) => Promise<CommandResult>;

export const defaultRunCommand: CommandRunner = (bin, args) =>
  new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        resolve({ code: null, stdout: "", stderr: "", notFound: true });
      } else {
        resolve({ code: null, stdout: "", stderr: String(err), notFound: false });
      }
    });
    child.stdout.on("data", (c) => stdoutChunks.push(c as Buffer));
    child.stderr.on("data", (c) => stderrChunks.push(c as Buffer));
    child.on("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        notFound: false,
      });
    });
  });

export const REQUIRED_NODE_MAJOR = 18;

function ok(label: string, detail?: string): CheckResult {
  return { label, status: "ok", detail };
}
function fail(label: string, detail: string, fix?: string, docs?: string): CheckResult {
  return { label, status: "fail", detail, fix, docs };
}
function warn(label: string, detail: string, fix?: string, docs?: string): CheckResult {
  return { label, status: "warning", detail, fix, docs };
}

// -----------------------------------------------------------------------------
// Phase 1: system prerequisites
// -----------------------------------------------------------------------------

export async function checkSystemPrerequisites(runCmd: CommandRunner): Promise<CheckResult[]> {
  return [await checkNode(runCmd), await checkGit(runCmd), await checkPnpm(runCmd)];
}

async function checkNode(runCmd: CommandRunner): Promise<CheckResult> {
  const r = await runCmd("node", ["--version"]);
  if (r.notFound) {
    return fail("node >=18", "node not found", "install Node.js >=18", "https://nodejs.org");
  }
  const v = r.stdout.trim();
  const major = Number(v.replace(/^v/, "").split(".")[0]);
  if (!Number.isFinite(major) || major < REQUIRED_NODE_MAJOR) {
    return fail(
      `node >=${REQUIRED_NODE_MAJOR}`,
      `found ${v || "(unknown)"}`,
      `install Node.js >=${REQUIRED_NODE_MAJOR}`,
      "https://nodejs.org",
    );
  }
  return ok("node", v);
}

async function checkGit(runCmd: CommandRunner): Promise<CheckResult> {
  const r = await runCmd("git", ["--version"]);
  if (r.notFound || r.code !== 0) {
    return fail("git", "git not found", "git is required; install from https://git-scm.com");
  }
  return ok("git", r.stdout.trim());
}

async function checkPnpm(runCmd: CommandRunner): Promise<CheckResult> {
  const r = await runCmd("pnpm", ["--version"]);
  if (r.notFound || r.code !== 0) {
    return warn("pnpm", "pnpm not found", "npm i -g pnpm", "https://pnpm.io");
  }
  return ok("pnpm", r.stdout.trim());
}

// -----------------------------------------------------------------------------
// Phase 3: agent discovery
// -----------------------------------------------------------------------------

export interface AgentCheckResult {
  role: AgentRole;
  agentId: string;
  handshake: CheckResult;
}

export async function checkDirectAgent(
  command: AgentCommand,
  role: AgentRole,
  tmpDir: string,
): Promise<AgentCheckResult> {
  const adapter = new SdkAcpAgentAdapter({ commands: [command] });
  try {
    const session = await adapter.spawn(tmpDir, command.id, {
      sessionName: `marshal-doctor-${role}`,
      permissionMode: "deny-all",
      timeoutSeconds: 10,
    });
    await adapter.close(session);
    return {
      role,
      agentId: command.id,
      handshake: ok(`${command.id} handshake`, "ACP session created"),
    };
  } catch (err) {
    return {
      role,
      agentId: command.id,
      handshake: warn(
        `${command.id} handshake`,
        `direct ACP agent unavailable: ${err instanceof Error ? err.message : String(err)}`,
        `verify agents.${role}.command and agents.${role}.args in ~/.marshal/config.json`,
        "https://agentclientprotocol.com",
      ),
    };
  }
}

// -----------------------------------------------------------------------------
// Phase 5: config generation / merge
// -----------------------------------------------------------------------------

export function getGlobalConfigPath(): string {
  return process.env.MARSHAL_GLOBAL_CONFIG ?? resolve(getGlobalDir(), "config.json");
}

export function machineAlreadyConfigured(configPath: string = getGlobalConfigPath()): boolean {
  if (!existsSync(configPath)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const cfg = parsed as GlobalConfig;
  const builder = cfg.agents?.builder;
  const validator = cfg.agents?.validator;
  return isAgentCommand(builder) && isAgentCommand(validator);
}

export function generateConfig(detected: {
  builder: AgentCommand;
  validator: AgentCommand;
  specAuthor?: AgentCommand;
}): GlobalConfig {
  return {
    agents: {
      builder: detected.builder,
      validator: detected.validator,
      ...(detected.specAuthor ? { specAuthor: detected.specAuthor } : {}),
    },
    policy: { maxRetries: DEFAULT_MAX_RETRIES },
  };
}

export function mergeConfig(existing: GlobalConfig, patch: GlobalConfig): GlobalConfig {
  const { acpx: _retiredAcpx, ...retained } = existing as GlobalConfig & { acpx?: unknown };
  const merged: GlobalConfig = { ...retained };
  merged.agents = {
    ...patch.agents,
    ...(isAgentCommand(existing.agents?.builder) ? { builder: existing.agents.builder } : {}),
    ...(isAgentCommand(existing.agents?.validator) ? { validator: existing.agents.validator } : {}),
    ...(isAgentCommand(existing.agents?.specAuthor)
      ? { specAuthor: existing.agents.specAuthor }
      : {}),
  };
  merged.policy = {
    ...patch.policy,
    ...existing.policy,
  };
  return merged;
}

export function writeGlobalConfig(
  config: GlobalConfig,
  configPath: string = getGlobalConfigPath(),
): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

export function readGlobalConfig(configPath: string = getGlobalConfigPath()): GlobalConfig | null {
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, "utf8")) as GlobalConfig;
  } catch {
    return null;
  }
}

// Status-line rendering ---------------------------------------------------------

export function formatCheckLine(result: CheckResult): string {
  const icon = result.status === "ok" ? "✓" : result.status === "fail" ? "✗" : "⚠";
  const base = `${icon} ${result.label}`;
  const detail = result.detail ? ` (${result.detail})` : "";
  const fix = result.fix ? ` — fix: ${result.fix}` : "";
  const docs = result.docs ? ` — docs: ${result.docs}` : "";
  return `${base}${detail}${fix}${docs}`;
}
