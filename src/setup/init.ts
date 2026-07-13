import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { initGlobalConfig, initRepoState, getRepoStateDir } from "../daemon/config.js";
import { openDb } from "../db/index.js";
import { resolveAgentId, type GlobalConfig } from "../worktree/config.js";
import {
  ACPX_PINNED_VERSION,
  checkAcpx,
  checkAgent,
  checkAuthEnv,
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
  repoRoot?: string;
  configPath?: string;
  runCmd?: CommandRunner;
  prompt?: YesNoPrompt;
  env?: EnvView;
  acpxBin?: string;
  versionRange?: string;
}

export interface InitResult {
  ok: boolean;
  skippedMachine: boolean;
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
  const versionRange = options.versionRange ?? ACPX_PINNED_VERSION;
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
  const phase2 = await checkAcpx(runCmd, { binPath: acpxBin, versionRange });
  for (const r of phase2) print(formatCheckLine(r));
  const acpxMissing = phase2.some((r) => r.status === "fail");
  if (acpxMissing && !nonInteractive) {
    await maybeInstallAcpx(runCmd, prompt, versionRange);
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

  // Phase 4 — auth environment
  for (const result of agentResults) {
    const auth = checkAuthEnv(result.agentId, env);
    if (auth) {
      print(formatCheckLine(auth));
    } else {
      print(`⚠ ${result.agentId} auth — unknown agent; ensure its auth is configured per its docs`);
    }
  }

  // Phase 5 — config generation
  if (nonInteractive) {
    if (machineAlreadyConfigured(configPath)) {
      print(`✓ config present at ${configPath}`);
    } else {
      print(`✗ config missing at ${configPath} (init writes config only when interactive)`);
    }
  } else {
    const generated = generateConfig({
      acpxBin,
      versionRange,
      builder: builderId,
      validator: validatorId,
    });
    const merged =
      existing && Object.keys(existing).length > 0 ? mergeConfig(existing, generated) : generated;
    printConfigPreview(merged, configPath);
    const confirmed = await prompt("Write this config?");
    if (confirmed) {
      writeGlobalConfig(merged, configPath);
      print(`✓ config written to ${configPath}`);
    } else {
      print("— config not written");
    }
  }

  // Phase 6 — repo init (always runs)
  initGlobalConfig();
  initRepoState(repoRoot);
  openDb(repoRoot);
  print(`✓ repo initialized at ${getRepoStateDir(repoRoot)}`);

  const ok =
    phase1.every((r) => r.status !== "fail") &&
    phase2.every((r) => r.status !== "fail") &&
    agentResults.every((a) => a.installed.status !== "fail");

  if (ok) printReady();
  return { ok, skippedMachine: false };
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
  const env: EnvView = options.env ?? process.env;
  const configPath = options.configPath ?? getGlobalConfigPath();
  const versionRange = options.versionRange ?? ACPX_PINNED_VERSION;
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
    const result = await checkAgent(runCmd, id, acpxBin, role, tmp);
    print(formatCheckLine(result.installed));
    print(formatCheckLine(result.handshake));
    const auth = checkAuthEnv(result.agentId, env);
    if (auth) {
      print(formatCheckLine(auth));
    } else {
      print(`⚠ ${result.agentId} auth — unknown agent; ensure its auth is configured per its docs`);
    }
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
