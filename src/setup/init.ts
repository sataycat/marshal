import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { initGlobalConfig, initRepoState, getRepoStateDir } from "../daemon/config.js";
import { openDb } from "../db/index.js";
import { resolveAgentId, type GlobalConfig } from "../worktree/config.js";
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
  type CheckResult,
  type CommandRunner,
  type EnvView,
} from "./preflight.js";

export type YesNoPrompt = (question: string) => Promise<boolean>;

function defaultYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^[yY]/.test(answer.trim()));
    });
  });
}

export interface InitOptions {
  nonInteractive?: boolean;
  // ADR-022 Decision 3: explicit, programmatic consent to write files
  // (`~/.marshal/config.json` and `.marshal/state.db`). Only honored when
  // `nonInteractive` is true; in interactive mode the user is asked via the
  // prompt instead.
  yes?: boolean;
  repoRoot?: string;
  configPath?: string;
  runCmd?: CommandRunner;
  prompt?: YesNoPrompt;
  env?: EnvView;
  acpxBin?: string;
  versionRange?: string;
  installPin?: string;
}

export interface InitResult {
  ok: boolean;
  skippedMachine: boolean;
}

// ADR-022 Decision 1: the repo is considered "already initialized" when a
// state database is already on disk. In that case the merged prompt is skipped
// and Phase 6 runs as a no-op idempotent call, preserving the fast re-run.
function repoAlreadyInitialized(repoRoot: string): boolean {
  return existsSync(join(getRepoStateDir(repoRoot), "state.db"));
}

// ADR-022 Decision 3: env opt-in recognized in --non-interactive mode so CI
// pipelines can consent to writes without a TTY. Marshal no longer reads any
// other env vars from the user; in particular it does not inspect provider
// auth env vars (Decision 2).
function envYes(env: EnvView): boolean {
  return env.MARSHAL_INIT_YES === "1";
}

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

export async function runInit(options: InitOptions = {}): Promise<InitResult> {
  const runCmd = options.runCmd ?? defaultRunCommand;
  const prompt = options.prompt ?? defaultYesNo;
  const env: EnvView = options.env ?? process.env;
  const repoRoot = options.repoRoot ?? process.cwd();
  const configPath = options.configPath ?? getGlobalConfigPath();
  const nonInteractive = options.nonInteractive === true;
  const yesFlag = options.yes === true || envYes(env);
  const versionRange = options.versionRange ?? ACPX_ACCEPT_RANGE;
  const installPin = options.installPin ?? ACPX_INSTALL_PIN;
  const acpxBin = options.acpxBin ?? "acpx";

  if (!nonInteractive && machineAlreadyConfigured(configPath)) {
    print("✓ machine already configured");
    initRepoState(repoRoot);
    openDb(repoRoot);
    print(`✓ repo initialized at ${getRepoStateDir(repoRoot)}`);
    printReady();
    return { ok: true, skippedMachine: true };
  }

  // Phase 1
  const phase1 = await checkSystemPrerequisites(runCmd);
  for (const r of phase1) print(formatCheckLine(r));
  if (phase1.some((r) => r.status === "fail")) {
    return { ok: false, skippedMachine: false };
  }
  // pnpm is only a warning; offer to install interactively.
  if (!nonInteractive) {
    await maybeInstallPnpm(phase1, runCmd, prompt);
  }

  // Phase 2
  let phase2 = await checkAcpx(runCmd, { binPath: acpxBin, versionRange });
  for (const r of phase2) print(formatCheckLine(r));
  const acpxMissing = phase2.some((r) => r.status === "fail");
  if (acpxMissing && !nonInteractive) {
    await maybeInstallAcpx(runCmd, prompt, installPin);
    // Re-probe so the rest of the flow (and the short-circuit below) sees the
    // post-install state rather than the pre-install snapshot.
    phase2 = await checkAcpx(runCmd, { binPath: acpxBin, versionRange });
    for (const r of phase2) print(formatCheckLine(r));
  }
  // acpx is a hard dependency: typed `fail` (not `warning`) in preflight. If it
  // is still failing here — either the install was declined (interactive), the
  // install attempt failed, or we are in --non-interactive mode where no
  // install is offered — stop now. Running the Phase 3 agent probes against a
  // missing acpx would only produce noise (every agent would `fail`/`warn` with
  // "acpx not installed"), and Phase 5/6 must not write `~/.marshal/config.json`
  // or `.marshal/state.db` for a machine that cannot run the loop.
  if (phase2.some((r) => r.status === "fail")) {
    print(
      `✗ acpx is required and is still missing. Install with \`npm i -g acpx@${installPin}\` and re-run \`marshal init\`.`,
    );
    return { ok: false, skippedMachine: false };
  }

  // Phase 3 — agent discovery
  const existing = readGlobalConfig(configPath) ?? {};
  const builderId = resolveAgentId("builder", existing);
  const validatorId = resolveAgentId("validator", existing);
  const tmp = mkdtempSync(join(tmpdir(), "marshal-preflight-"));
  const agentResults: AgentCheckResult[] = [];
  for (const { role, id } of [
    { role: "builder" as const, id: builderId },
    { role: "validator" as const, id: validatorId },
  ]) {
    const result = await checkAgent(runCmd, id, acpxBin, role, tmp);
    agentResults.push(result);
    print(formatCheckLine(result.installed));
    print(formatCheckLine(result.handshake));
    if (!nonInteractive) {
      await maybeInstallAgent(result, runCmd, prompt);
    }
  }

  // ADR-022 Decision 2: no Phase 4 "auth environment" check. The authoritative
  // "can this agent run" signal is the ACP handshake probe surfaced above.
  // Marshal no longer names or inspects provider env vars.

  // Phases 5+6 (merged, ADR-022 Decision 1). A single user-visible step governs
  // both writing `~/.marshal/config.json` (when not present / when a merge is
  // proposed) and creating `.marshal/state.db` + the repo state dir. On
  // already-initialized repos the prompt is skipped and Phase 6 runs as a
  // no-op idempotent create-if-missing; the fast re-run property is preserved
  // where it actually matters.
  const repoNeedsInit = !repoAlreadyInitialized(repoRoot);
  const machineNeedsConfig = !machineAlreadyConfigured(configPath);
  const needsPrompt = machineNeedsConfig || repoNeedsInit;

  // Generate+merge the config snapshot even when not writing it, so the
  // preview is shown in non-interactive mode for diagnostic visibility.
  const generated = generateConfig({
    acpxBin,
    versionRange,
    builder: builderId,
    validator: validatorId,
  });
  const merged =
    existing && Object.keys(existing).length > 0 ? mergeConfig(existing, generated) : generated;

  if (nonInteractive) {
    // ADR-022 Decision 3: write nothing unless `--yes` / `MARSHAL_INIT_YES=1`.
    if (yesFlag) {
      writeInitFiles(machineNeedsConfig, merged, configPath, repoRoot);
    } else {
      if (machineNeedsConfig) {
        print(`✗ config missing at ${configPath} (re-run with --yes to write it)`);
      } else {
        print(`✓ config present at ${configPath}`);
      }
      if (repoNeedsInit) {
        print(`✗ repo not initialized at ${getRepoStateDir(repoRoot)} (re-run with --yes to init)`);
      }
      print("— non-interactive mode: no files written (pass --yes to write)");
    }
  } else if (needsPrompt) {
    printConfigPreview(merged, configPath);
    const confirmed = await prompt(
      "Initialize Marshal in this repo (writes ~/.marshal/config.json and .marshal/state.db)?",
    );
    if (confirmed) {
      writeInitFiles(machineNeedsConfig, merged, configPath, repoRoot);
    } else {
      print("— initialization skipped; no files written");
    }
  } else {
    // Both already initialized — Phase 6 runs as an idempotent no-op.
    initRepoState(repoRoot);
    openDb(repoRoot);
    print(`✓ repo initialized at ${getRepoStateDir(repoRoot)}`);
  }

  const checksOk =
    phase1.every((r) => r.status !== "fail") &&
    phase2.every((r) => r.status !== "fail") &&
    agentResults.every((a) => a.installed.status !== "fail");

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

function printConfigPreview(config: GlobalConfig, configPath: string): void {
  print(`— config preview (${configPath}):`);
  print(JSON.stringify(config, null, 2));
}

async function maybeInstallPnpm(
  phase1: CheckResult[],
  runCmd: CommandRunner,
  prompt: YesNoPrompt,
): Promise<void> {
  const pnpm = phase1.find((r) => r.label === "pnpm");
  if (pnpm && pnpm.status === "warning" && pnpm.fix) {
    if (await prompt(`pnpm not found. Install with \`${pnpm.fix}\`?`)) {
      await runInstall(runCmd, pnpm.fix);
    }
  }
}

async function maybeInstallAcpx(
  runCmd: CommandRunner,
  prompt: YesNoPrompt,
  versionRange: string,
): Promise<void> {
  if (await prompt(`acpx not found. Install with \`npm i -g acpx@${versionRange}\`?`)) {
    await runInstall(runCmd, `npm i -g acpx@${versionRange}`);
  }
}

async function maybeInstallAgent(
  result: AgentCheckResult,
  runCmd: CommandRunner,
  prompt: YesNoPrompt,
): Promise<void> {
  if (result.installed.status === "fail" && result.installed.fix) {
    if (
      await prompt(
        `Agent '${result.agentId}' not available. Install with \`${result.installed.fix}\`?`,
      )
    ) {
      await runInstall(runCmd, result.installed.fix);
    }
  }
}

async function runInstall(runCmd: CommandRunner, command: string): Promise<void> {
  const parts = command.split(/\s+/);
  const bin = parts[0];
  const args = parts.slice(1);
  const r = await runCmd(bin, args);
  if (r.notFound || r.code !== 0) {
    print(`✗ install failed: ${command} (${r.notFound ? "not found" : `exit ${r.code}`})`);
    return;
  }
  print(`✓ installed via ${command}`);
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
  const builderId = resolveAgentId("builder", existing);
  const validatorId = resolveAgentId("validator", existing);

  let ok = true;

  const phase1 = await checkSystemPrerequisites(runCmd);
  for (const r of phase1) print(formatCheckLine(r));
  if (phase1.some((r) => r.status === "fail")) ok = false;

  const phase2 = await checkAcpx(runCmd, { binPath: acpxBin, versionRange });
  for (const r of phase2) print(formatCheckLine(r));
  if (phase2.some((r) => r.status === "fail")) ok = false;

  const tmp = mkdtempSync(join(tmpdir(), "marshal-doctor-"));
  for (const { role, id } of [
    { role: "builder" as const, id: builderId },
    { role: "validator" as const, id: validatorId },
  ]) {
    // ADR-022 Decision 2: handshake probe is the authoritative auth signal;
    // no provider env presence check is emitted here.
    const result = await checkAgent(runCmd, id, acpxBin, role, tmp);
    print(formatCheckLine(result.installed));
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
