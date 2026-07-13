import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initGlobalConfig, initRepoState, getRepoStateDir } from "../daemon/config.js";
import { openDb } from "../db/index.js";
import { AGENT_ID_DEFAULTS, type GlobalConfig } from "../worktree/config.js";
import {
  ACPX_ACCEPT_RANGE,
  ACPX_INSTALL_PIN,
  checkAcpx,
  checkAgent,
  checkSystemPrerequisites,
  defaultRunCommand,
  formatCheckLine,
  generateConfig,
  getGlobalConfigPath,
  machineAlreadyConfigured,
  mergeConfig,
  readGlobalConfig,
  writeGlobalConfig,
  type AgentCheckResult,
  type CommandRunner,
} from "./preflight.js";

export interface InitOptions {
  repoRoot?: string;
  configPath?: string;
  runCmd?: CommandRunner;
  acpxBin?: string;
  versionRange?: string;
  installPin?: string;
}

export interface InitResult {
  ok: boolean;
  skippedMachine: boolean;
}

// ADR-022 Decision 1: the repo is considered "already initialized" when a
// state database is already on disk. In that case the write step is skipped
// and Phase 6 runs as a no-op idempotent call, preserving the fast re-run.
function repoAlreadyInitialized(repoRoot: string): boolean {
  return existsSync(join(getRepoStateDir(repoRoot), "state.db"));
}

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

// ADR-024 Decision 3: `marshal init` is always non-interactive. No prompts,
// no --yes / --non-interactive flags, no consent gates. The user runs
// `marshal init` to initialize; that is the consent. The flow is:
//   Phase 1: system prereqs (node, git, pnpm). fail → exit non-zero.
//   Phase 2: acpx check. fail → print install command + docs, exit non-zero.
//   Phase 3: agent probing is REMOVED from init (ADR-024 Decision 3). Init
//            writes the config with AGENT_ID_DEFAULTS and initializes repo
//            state. Agent verification is `marshal doctor`'s job.
//   Phase 4/5/6 (merged): generate config, merge with existing, write
//            ~/.marshal/config.json + .marshal/state.db unconditionally.
export async function runInit(options: InitOptions = {}): Promise<InitResult> {
  const runCmd = options.runCmd ?? defaultRunCommand;
  const repoRoot = options.repoRoot ?? process.cwd();
  const configPath = options.configPath ?? getGlobalConfigPath();
  const versionRange = options.versionRange ?? ACPX_ACCEPT_RANGE;
  const installPin = options.installPin ?? ACPX_INSTALL_PIN;
  const acpxBin = options.acpxBin ?? "acpx";

  if (machineAlreadyConfigured(configPath)) {
    print("✓ machine already configured");
    initRepoState(repoRoot);
    openDb(repoRoot);
    print(`✓ repo initialized at ${getRepoStateDir(repoRoot)}`);
    printReady();
    return { ok: true, skippedMachine: true };
  }

  // Phase 1 — system prerequisites.
  const phase1 = await checkSystemPrerequisites(runCmd);
  for (const r of phase1) print(formatCheckLine(r));
  if (phase1.some((r) => r.status === "fail")) {
    return { ok: false, skippedMachine: false };
  }

  // Phase 2 — acpx hard-gate (ADR-024 Decision 1). If acpx is missing or
  // outside the accept range with a `fail` status, print the install command
  // and stop. No in-process `npm i -g` attempt, no fake `✓` line, no
  // re-probe loop, no continuation into agent probes.
  const phase2 = await checkAcpx(runCmd, { binPath: acpxBin, versionRange });
  for (const r of phase2) print(formatCheckLine(r));
  if (phase2.some((r) => r.status === "fail")) {
    print(
      `✗ acpx is required and is missing. Install with \`npm i -g acpx@${installPin}\` and re-run \`marshal init\`.`,
    );
    return { ok: false, skippedMachine: false };
  }

  // Phase 3 — agent probing is REMOVED from init (ADR-024 Decision 3).
  // Init writes the config with AGENT_ID_DEFAULTS; agent verification is
  // `marshal doctor`'s job.

  // Phases 5+6 (merged, ADR-022 Decision 1 + ADR-024 Decision 3). Generate
  // the config from defaults (or preserve existing config values), merge,
  // and write unconditionally — no prompt, no preview, no consent gate.
  const existing = readGlobalConfig(configPath) ?? {};
  const builderId = existing.agents?.builder ?? AGENT_ID_DEFAULTS.builder;
  const validatorId = existing.agents?.validator ?? AGENT_ID_DEFAULTS.validator;
  const specAuthorId = existing.agents?.specAuthor ?? AGENT_ID_DEFAULTS.specAuthor;

  const generated = generateConfig({
    acpxBin,
    versionRange,
    builder: builderId,
    validator: validatorId,
    specAuthor: specAuthorId,
  });
  const merged =
    existing && Object.keys(existing).length > 0 ? mergeConfig(existing, generated) : generated;

  const machineNeedsConfig = !machineAlreadyConfigured(configPath);
  const repoNeedsInit = !repoAlreadyInitialized(repoRoot);

  if (machineNeedsConfig || repoNeedsInit) {
    writeInitFiles(machineNeedsConfig, merged, configPath, repoRoot);
  } else {
    // Both already initialized — Phase 6 runs as an idempotent no-op.
    initRepoState(repoRoot);
    openDb(repoRoot);
    print(`✓ repo initialized at ${getRepoStateDir(repoRoot)}`);
  }

  const checksOk =
    phase1.every((r) => r.status !== "fail") && phase2.every((r) => r.status !== "fail");

  if (checksOk) printReady();
  return { ok: checksOk, skippedMachine: false };
}

// Shared write path for the merged Phase 5+6 (ADR-022 Decision 1): writes the
// global config (only when needed), then initializes the repo state dir and
// opens the database.
function writeInitFiles(
  machineNeedsConfig: boolean,
  config: GlobalConfig,
  configPath: string,
  repoRoot: string,
): void {
  if (machineNeedsConfig) {
    writeGlobalConfig(config, configPath);
    print(`✓ config written to ${configPath}`);
  } else {
    print(`✓ config present at ${configPath}`);
  }
  initGlobalConfig();
  initRepoState(repoRoot);
  openDb(repoRoot);
  print(`✓ repo initialized at ${getRepoStateDir(repoRoot)}`);
}

function printReady(): void {
  print("\nMarshal is ready. Create your first task:");
  print('  marshal task create --slug my-feature --title "My feature" --spec-file spec.md');
}

// -----------------------------------------------------------------------------
// doctor
// -----------------------------------------------------------------------------

export async function runDoctor(options: InitOptions = {}): Promise<{ ok: boolean }> {
  const runCmd = options.runCmd ?? defaultRunCommand;
  const configPath = options.configPath ?? getGlobalConfigPath();
  const versionRange = options.versionRange ?? ACPX_ACCEPT_RANGE;
  const acpxBin = options.acpxBin ?? "acpx";

  const existing = readGlobalConfig(configPath) ?? {};
  const builderId = existing.agents?.builder;
  const validatorId = existing.agents?.validator;

  let ok = true;

  const phase1 = await checkSystemPrerequisites(runCmd);
  for (const r of phase1) print(formatCheckLine(r));
  if (phase1.some((r) => r.status === "fail")) ok = false;

  const phase2 = await checkAcpx(runCmd, { binPath: acpxBin, versionRange });
  for (const r of phase2) print(formatCheckLine(r));
  if (phase2.some((r) => r.status === "fail")) ok = false;

  const tmpDir = initTmpDir();
  for (const { role, id } of [
    { role: "builder" as const, id: builderId },
    { role: "validator" as const, id: validatorId },
  ]) {
    if (!id) {
      print(
        formatCheckLine({
          label: `agents.${role}`,
          status: "fail",
          detail: `not configured in ${configPath}`,
          fix: `set agents.${role} in ~/.marshal/config.json (see https://acpx.sh/agents.html)`,
        }),
      );
      ok = false;
      continue;
    }
    // ADR-024 Decision 2: session probe is the authoritative "can this agent
    // run" signal. No provider env presence check is emitted here.
    const result = await checkAgent(runCmd, id, acpxBin, role, tmpDir);
    print(formatCheckLine(result.handshake));
  }

  if (machineAlreadyConfigured(configPath)) {
    print(`✓ config present at ${configPath}`);
  } else {
    print(`✗ config missing at ${configPath}`);
    ok = false;
  }

  print(ok ? "\nAll checks passed." : "\nSome checks failed.");
  return { ok };
}

function initTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "marshal-doctor-"));
}
