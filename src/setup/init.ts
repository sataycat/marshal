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

function repoAlreadyInitialized(repoRoot: string): boolean {
  return existsSync(join(getRepoStateDir(repoRoot), "state.db"));
}

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * Non-interactive init flow (ADR-024):
 *   1. System prereqs (node, git, pnpm) — skipped if already configured.
 *   2. acpx hard-gate — fail → single install message, exit non-zero.
 *   3. Generate/merge config + initialize repo state.
 */
export async function runInit(options: InitOptions = {}): Promise<InitResult> {
  const runCmd = options.runCmd ?? defaultRunCommand;
  const repoRoot = options.repoRoot ?? process.cwd();
  const configPath = options.configPath ?? getGlobalConfigPath();
  const versionRange = options.versionRange ?? ACPX_ACCEPT_RANGE;
  const installPin = options.installPin ?? ACPX_INSTALL_PIN;
  const acpxBin = options.acpxBin ?? "acpx";

  const alreadyConfigured = machineAlreadyConfigured(configPath);

  // Phase 1 — system prerequisites (skipped on fast path).
  let phase1: Awaited<ReturnType<typeof checkSystemPrerequisites>> = [];
  if (!alreadyConfigured) {
    phase1 = await checkSystemPrerequisites(runCmd);
    for (const r of phase1) print(formatCheckLine(r));
    if (phase1.some((r) => r.status === "fail")) {
      return { ok: false, skippedMachine: false };
    }
  }

  // Phase 2 — acpx hard-gate. Print a single message on failure instead of
  // echoing each sub-check (path + version) redundantly.
  const phase2 = await checkAcpx(runCmd, { binPath: acpxBin, versionRange });
  if (phase2.some((r) => r.status === "fail")) {
    print(
      `✗ acpx is required. Install with \`npm i -g acpx@${installPin}\` and re-run \`marshal init\`.`,
    );
    return { ok: false, skippedMachine: false };
  }
  for (const r of phase2) print(formatCheckLine(r));

  // Fast path — machine already configured, just ensure repo state.
  if (alreadyConfigured) {
    print("✓ machine already configured");
    initRepoState(repoRoot);
    openDb(repoRoot);
    print(`✓ repo initialized at ${getRepoStateDir(repoRoot)}`);
    printReady();
    return { ok: true, skippedMachine: true };
  }

  // Phase 3 — generate config from defaults, merge with existing, write.
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
    initRepoState(repoRoot);
    openDb(repoRoot);
    print(`✓ repo initialized at ${getRepoStateDir(repoRoot)}`);
  }

  printReady();
  return { ok: true, skippedMachine: false };
}

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
