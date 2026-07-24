import { existsSync } from "node:fs";
import { initGlobalConfig } from "../daemon/config.js";
import { openDb } from "../db/index.js";
import { AGENT_COMMAND_DEFAULTS, isAgentCommand, type GlobalConfig } from "../worktree/config.js";
import { createStorageTemporaryDirectory } from "../storage/layout.js";
import {
  checkDirectAgent,
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
}

export interface InitResult {
  ok: boolean;
  skippedMachine: boolean;
}

function repoAlreadyInitialized(_repoRoot: string): boolean { return existsSync(initGlobalConfig()); }

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * Non-interactive init flow (ADR-024):
 *   1. System prereqs (node, git, pnpm) — skipped if already configured.
 *   2. Generate/merge direct ACP config + initialize repo state.
 */
export async function runInit(options: InitOptions = {}): Promise<InitResult> {
  const runCmd = options.runCmd ?? defaultRunCommand;
  const repoRoot = options.repoRoot ?? process.cwd();
  const configPath = options.configPath ?? getGlobalConfigPath();
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

  // Fast path — machine already configured, just ensure repo state.
  if (alreadyConfigured) {
    print("✓ machine already configured");
    openDb(repoRoot);
    print("✓ daemon database initialized");
    printReady();
    return { ok: true, skippedMachine: true };
  }

  // Phase 3 — generate config from defaults, merge with existing, write.
  const existing = readGlobalConfig(configPath) ?? {};
  const builder = isAgentCommand(existing.agents?.builder)
    ? existing.agents.builder
    : AGENT_COMMAND_DEFAULTS.builder;
  const validator = isAgentCommand(existing.agents?.validator)
    ? existing.agents.validator
    : AGENT_COMMAND_DEFAULTS.validator;
  const specAuthor = isAgentCommand(existing.agents?.specAuthor)
    ? existing.agents.specAuthor
    : AGENT_COMMAND_DEFAULTS.specAuthor;

  const generated = generateConfig({
    builder,
    validator,
    specAuthor,
  });
  const merged =
    existing && Object.keys(existing).length > 0 ? mergeConfig(existing, generated) : generated;

  const machineNeedsConfig = !machineAlreadyConfigured(configPath);
  const repoNeedsInit = !repoAlreadyInitialized(repoRoot);

  if (machineNeedsConfig || repoNeedsInit) {
    writeInitFiles(machineNeedsConfig, merged, configPath, repoRoot);
  } else {
    openDb(repoRoot);
    print("✓ daemon database initialized");
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
  openDb(repoRoot);
  print("✓ daemon database initialized");
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
  const existing = readGlobalConfig(configPath) ?? {};
  const builderId = existing.agents?.builder;
  const validatorId = existing.agents?.validator;

  let ok = true;

  const phase1 = await checkSystemPrerequisites(runCmd);
  for (const r of phase1) print(formatCheckLine(r));
  if (phase1.some((r) => r.status === "fail")) ok = false;

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
          fix: `set agents.${role} to { id, command, args, env? } in ~/.marshal/config.json`,
        }),
      );
      ok = false;
      continue;
    }
    if (!isAgentCommand(id)) {
      print(
        formatCheckLine({
          label: `agents.${role}`,
          status: "fail",
          detail: "string agent IDs are no longer supported",
          fix: `replace agents.${role} with { id, command, args, env? } in ~/.marshal/config.json`,
          docs: "https://agentclientprotocol.com",
        }),
      );
      ok = false;
      continue;
    }
    const result = await checkDirectAgent(id, role, tmpDir);
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
  return createStorageTemporaryDirectory("doctor");
}
