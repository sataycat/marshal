import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import {
  ACPX_INSTALL_PIN,
  DEFAULT_VERSION_RANGE,
  satisfiesVersionRange,
} from "../agent/acpx-adapter.js";
import { DEFAULT_MAX_RETRIES, type AgentRole, type GlobalConfig } from "../worktree/config.js";
import { ACPX_AUTH_DOCS, AGENT_INSTALL_HINTS } from "./hints.js";

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

// `ACPX_ACCEPT_RANGE` is what an already-installed acpx must satisfy; it is
// passed to `checkAcpx` and written into `config.acpx.version`. `ACPX_INSTALL_PIN`
// is the exact version string used in `npm i -g acpx@...` install hints. See
// ADR-023 Decision 6 and the doc comment in `acpx-adapter.ts`.
export const ACPX_ACCEPT_RANGE = DEFAULT_VERSION_RANGE;
export { ACPX_INSTALL_PIN };

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
// Phase 2: ACPX
// -----------------------------------------------------------------------------

export interface AcpxCheckOptions {
  binPath: string;
  versionRange: string;
}

export async function checkAcpx(
  runCmd: CommandRunner,
  opts: AcpxCheckOptions,
): Promise<CheckResult[]> {
  return [await checkAcpxPath(runCmd, opts.binPath), await checkAcpxVersion(runCmd, opts)];
}

async function checkAcpxPath(runCmd: CommandRunner, binPath: string): Promise<CheckResult> {
  if (binPath !== "acpx") {
    if (!existsSync(binPath)) {
      return fail(
        "acpx",
        `not found at ${binPath}`,
        "install acpx",
        "https://github.com/openclaw/acpx",
      );
    }
    return ok("acpx", binPath);
  }
  const r = await runCmd("which", ["acpx"]);
  if (r.notFound || r.code !== 0 || !r.stdout.trim()) {
    return fail(
      "acpx",
      "not on PATH",
      `npm i -g acpx@${ACPX_INSTALL_PIN}`,
      "https://github.com/openclaw/acpx",
    );
  }
  return ok("acpx", r.stdout.trim());
}

async function checkAcpxVersion(
  runCmd: CommandRunner,
  opts: AcpxCheckOptions,
): Promise<CheckResult> {
  const r = await runCmd(opts.binPath, ["--version"]);
  if (r.notFound) {
    return fail("acpx version", "acpx not installed", `npm i -g acpx@${ACPX_INSTALL_PIN}`);
  }
  if (r.code !== 0) {
    return fail("acpx version", `acpx --version failed: ${(r.stderr || r.stdout).trim()}`);
  }
  const version = r.stdout.trim();
  if (!satisfiesVersionRange(version, opts.versionRange)) {
    return warn(
      "acpx version",
      `found ${version}, expected ${opts.versionRange}`,
      `npm i -g acpx@${ACPX_INSTALL_PIN}`,
    );
  }
  return ok("acpx version", version);
}

// -----------------------------------------------------------------------------
// Phase 3: agent discovery
// -----------------------------------------------------------------------------

export interface AgentCheckResult {
  role: AgentRole;
  agentId: string;
  handshake: CheckResult;
}

export async function checkAgent(
  runCmd: CommandRunner,
  agentId: string,
  acpxBin: string,
  role: AgentRole,
  tmpDir: string,
): Promise<AgentCheckResult> {
  return {
    role,
    agentId,
    handshake: await checkAgentHandshake(runCmd, agentId, acpxBin, tmpDir),
  };
}

// ADR-024 Decision 2: the "is this agent linked and usable" check is a
// zero-cost acpx session probe — `acpx <agent> sessions new` (ACP initialize +
// session/new, no LLM prompt, zero tokens) followed by `sessions close` for
// cleanup. This replaces the old `exec 'hello'` handshake (which consumed
// tokens) and the `--help` pre-check (which used an undocumented probe
// surface). If `sessions new` fails, `sessions close` is skipped.
async function checkAgentHandshake(
  runCmd: CommandRunner,
  agentId: string,
  acpxBin: string,
  tmpDir: string,
): Promise<CheckResult> {
  const r = await runCmd(acpxBin, [
    "--cwd",
    tmpDir,
    "--timeout",
    "10",
    "--format",
    "json",
    agentId,
    "sessions",
    "new",
  ]);
  if (r.notFound) {
    return warn(`${agentId} handshake`, "acpx not installed");
  }
  if (r.code !== 0) {
    // ADR-022 Decision 2: this is the authoritative "can this agent run" probe.
    // Surface the agent's own stderr/stdout verbatim and point at the agent's
    // docs (curated hint) or the ACPX docs as a fallback. Marshal never names a
    // provider env var — auth diagnosis lives with the agent and ACPX, where it
    // belongs.
    const hint = AGENT_INSTALL_HINTS[agentId];
    const docs = hint?.docs ?? ACPX_AUTH_DOCS;
    const fix = hint
      ? `ensure \`${hint.acpxCommand}\` runs (acpx adapter command)`
      : `install the '${agentId}' agent per its docs`;
    const detail = `agent not available via acpx: ${
      (r.stderr || r.stdout).trim() || `exit ${r.code}`
    }`;
    return warn(`${agentId} handshake`, detail, fix, docs);
  }

  // Clean up the probe session. If parsing fails or close fails, it is
  // harmless — the session is ephemeral and pruned by acpx on next use.
  const sessionName = parseProbeSessionId(r.stdout);
  if (sessionName) {
    await runCmd(acpxBin, [
      "--cwd",
      tmpDir,
      agentId,
      "sessions",
      "close",
      sessionName,
    ]);
  }

  return ok(`${agentId} handshake`, "session created");
}

function parseProbeSessionId(stdout: string): string | null {
  const line = stdout.split("\n").find((l) => l.trim().length > 0);
  if (!line) return null;
  try {
    const record = JSON.parse(line) as Record<string, unknown>;
    const name = record.name as string | undefined;
    if (name) return name;
    const recordId = record.recordId as string | undefined;
    if (recordId) return recordId;
    const id = record.id as string | undefined;
    if (id) return id;
  } catch {
    // Non-JSON output; skip close.
  }
  return null;
}

// -----------------------------------------------------------------------------
// Phase 3 chooser: probe the ACPX built-in registry (ADR-023 Decision 4)
// -----------------------------------------------------------------------------

export interface AgentProbe {
  agentId: string;
  handshake: CheckResult;
}

export async function probeAgentCandidates(
  runCmd: CommandRunner,
  acpxBin: string,
  tmpDir: string,
): Promise<AgentProbe[]> {
  const ids = Object.keys(AGENT_INSTALL_HINTS);
  const probes: AgentProbe[] = [];
  for (const agentId of ids) {
    const handshake = await checkAgentHandshake(runCmd, agentId, acpxBin, tmpDir);
    probes.push({ agentId, handshake });
  }
  return probes;
}

export function renderProbeLine(probe: AgentProbe, index: number): string {
  const status = probe.handshake.status;
  const icon = status === "ok" ? "✓" : status === "warning" ? "⚠" : "✗";
  return `  [${index}] ${probe.agentId.padEnd(12)} ${icon} handshake ${status}`;
}

export function isProbeUsable(probe: AgentProbe): boolean {
  return probe.handshake.status === "ok" || probe.handshake.status === "warning";
}

// -----------------------------------------------------------------------------
// Phase 5: config generation / merge
// -----------------------------------------------------------------------------

export function getGlobalConfigPath(): string {
  return process.env.MARSHAL_GLOBAL_CONFIG ?? resolve(homedir(), ".marshal", "config.json");
}

// "Machine already configured" = a prior onboarding wrote a complete-enough
// config. A partial / hand-authored config that's missing acpx or the agent
// roles does NOT count — `init` then runs the preflight and Phase 5 merges to
// fill the gaps (ADR-020 Decision 1 + Phase 5).
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
  return Boolean(cfg.acpx && cfg.agents?.builder && cfg.agents?.validator);
}

export function generateConfig(detected: {
  acpxBin: string;
  versionRange: string;
  builder: string;
  validator: string;
  specAuthor?: string;
}): GlobalConfig {
  return {
    acpx: { bin: detected.acpxBin || "acpx", version: detected.versionRange },
    agents: {
      builder: detected.builder,
      validator: detected.validator,
      ...(detected.specAuthor ? { specAuthor: detected.specAuthor } : {}),
    },
    policy: { maxRetries: DEFAULT_MAX_RETRIES },
  };
}

export function mergeConfig(existing: GlobalConfig, patch: GlobalConfig): GlobalConfig {
  const merged: GlobalConfig = { ...existing };
  merged.acpx = {
    ...patch.acpx,
    ...existing.acpx,
  };
  merged.agents = {
    ...patch.agents,
    ...existing.agents,
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
