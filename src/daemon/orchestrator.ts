import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { cwd } from "node:process";
import type { Agent, AgentEvent, AgentSession, SpawnOptions } from "../agent/types.js";
import { logger } from "../logger.js";
import { openDb } from "../db/index.js";
import {
  getTask,
  transitionTask,
  incrementRetryCount,
  setLastFailure,
  clearRetryState,
  type Task,
} from "../tasks/store.js";
import { specRelPathFor } from "../tasks/freeze.js";
import type { TaskStatus } from "../tasks/state-machine.js";
import { WorktreeManager } from "../worktree/manager.js";
import { resolveMaxRetries, resolveAgentId } from "../worktree/config.js";
import { RunLog } from "./run-log.js";
import type { EventBus } from "./bus.js";
import { publishTaskTransitioned } from "./bus.js";
import { getWorkflowProfile } from "../workflows/store.js";
import { historicalProvenance } from "../agents/provenance.js";
import { getSelectedRepository } from "../repositories/store.js";
import { AcpSessionSupervisor } from "../acp/supervisor.js";

export interface RunOnceResult {
  slug: string;
  runId: number;
  commitSha: string;
  status: "built" | "error" | "skipped" | "validated" | "validation_failed";
  error?: string;
  reason?: string;
}

const BUILDER_TIMEOUT_SECONDS = 1800;
const BUILDER_PERMISSION_MODE = "approve-all" as const;
const VALIDATOR_TIMEOUT_SECONDS = 1800;
const VALIDATOR_PERMISSION_MODE = "approve-all" as const;
const DIFF_MAX_LINES = 2000;
const GATE_SENTINEL = "MARSHAL_GATE:";
const GATE_PASS = "pass";
const GATE_FAIL = "fail";

interface ReadyTaskRow {
  slug: string;
}

interface BuildRunRow {
  commit_sha: string | null;
}

export class NoTrunkRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoTrunkRefError";
  }
}

export type GateResult =
  | { result: "pass" }
  | { result: "fail"; reason: string }
  | { result: "absent" };

function gitInWorktree(worktreePath: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: worktreePath,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function tryGitInWorktree(worktreePath: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

export function detectTrunkRef(worktreePath: string): string {
  const candidates: string[][] = [
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    ["rev-parse", "--verify", "origin/main"],
    ["rev-parse", "--verify", "origin/master"],
    ["rev-parse", "--verify", "main"],
    ["rev-parse", "--verify", "master"],
  ];

  for (const args of candidates) {
    const out = tryGitInWorktree(worktreePath, args);
    if (out && out.length > 0) {
      if (args[0] === "symbolic-ref") {
        return out;
      }
      return args[args.length - 1];
    }
  }

  throw new NoTrunkRefError(
    "Could not detect a trunk ref. Tried origin/HEAD, origin/main, origin/master, main, master.",
  );
}

export function parseGateSentinel(events: Iterable<AgentEvent>): GateResult {
  let pass: { result: "pass" } | null = null;
  let fail: { result: "fail"; reason: string } | null = null;

  for (const event of events) {
    if (event.type !== "text") continue;
    for (const line of event.text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith(GATE_SENTINEL)) continue;
      const rest = trimmed.slice(GATE_SENTINEL.length).trim();
      if (rest === GATE_PASS) {
        if (pass === null) pass = { result: "pass" };
        continue;
      }
      if (rest.startsWith(GATE_FAIL)) {
        if (fail === null) {
          const reason = rest.slice(GATE_FAIL.length).trim();
          fail = { result: "fail", reason: reason.length > 0 ? reason : "no reason given" };
        }
        continue;
      }
    }
  }

  if (pass !== null) return pass;
  if (fail !== null) return fail;
  return { result: "absent" };
}

export function renderBuilderPrompt(task: Task): string {
  return [
    `You are working on task "${task.title}" (slug: ${task.slug}).`,
    "",
    "## Spec",
    "",
    task.spec_markdown.trimEnd(),
    "",
    "## Instructions",
    "",
    "Follow repo conventions (see AGENTS.md if present). Write tests for new code. Run type-checks and tests before finishing.",
    "",
    "Do not commit — your changes will be committed automatically when you finish.",
    "",
  ].join("\n");
}

export interface BuildTaskOptions {
  root?: string;
  agent?: Agent;
  manager?: WorktreeManager;
  builderAgentId?: string;
  bus?: EventBus;
  machineDir?: string;
}

function workflowAssignment(task: Task, role: "builder" | "validator", machineDir?: string) {
  const repository = getSelectedRepository(machineDir);
  const profile = task.repository_id && task.workflow_profile_id && repository?.id === task.repository_id
    ? getWorkflowProfile(repository.id, task.workflow_profile_id, machineDir)
    : undefined;
  const assignment = profile?.assignments.find((item) => item.role === role);
  if (!assignment && !task.workflow_profile_id) return { profile: undefined, assignment: undefined };
  if (!profile || !assignment) throw new Error(`Task workflow profile has no ${role} assignment`);
  return { profile, assignment };
}

export async function buildTask(
  slug: string,
  options: BuildTaskOptions = {},
): Promise<RunOnceResult> {
  const root = options.root;
  const task = getTask(slug, root);

  const manager = options.manager ?? new WorktreeManager(root ?? cwd());
   const resolved = workflowAssignment(task, "builder", options.machineDir);
   const builderAgentId = options.builderAgentId ?? resolved.assignment?.agent_id ?? (options.agent ? resolveAgentId("builder") : "test-builder");
   const builderVersion = resolved.assignment?.agent_version ?? "legacy";
  const runLog = new RunLog(root, options.bus);

  const worktree = manager.create(slug);
  const prompt = renderBuilderPrompt(task);
   const runId = runLog.startRun(task.id, "builder", builderAgentId, prompt, { agentVersion: builderVersion, agentProvenance: resolved.assignment?.agent_provenance ?? historicalProvenance(builderAgentId, builderVersion), assignmentConfig: resolved.assignment ? { model: resolved.assignment.model, mode: resolved.assignment.mode, permission_policy: resolved.profile?.permission_policy } : {} });

  const spawnOpts: SpawnOptions = {
    sessionName: `marshal-${slug}-builder`,
    permissionMode: BUILDER_PERMISSION_MODE,
    timeoutSeconds: BUILDER_TIMEOUT_SECONDS,
  };

   let session: AgentSession | undefined;
   let supervisorSessionId: string | undefined;
   const supervisor = new AcpSessionSupervisor({ root, machineDir: options.machineDir, agent: options.agent, permissionPolicy: resolved.profile?.permission_policy, workflow: true, permissionMode: options.agent && !resolved.profile ? "approve-all" : undefined, bus: options.bus });
  try {
    try {
       const started = await supervisor.start("workflow-run", String(runId), worktree.path, builderAgentId, builderVersion, { ...(resolved.assignment ? { model: resolved.assignment.model, mode: resolved.assignment.mode } : {}), sessionName: `marshal-${slug}-builder` });
       session = started.session;
       supervisorSessionId = started.record.id;
       runLog.setSupervisorEvidence(runId, { sessionId: started.record.id, capabilities: started.record.capabilities });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, slug, runId }, "Builder spawn failed");
      runLog.finishRun(runId, "error", { error: `spawn failed: ${msg}` });
      return { slug, runId, commitSha: "", status: "error", error: `spawn failed: ${msg}` };
    }

    let errorMessage: string | undefined;
    let seq = 0;

    try {
       await supervisor.prompt(supervisorSessionId, prompt, undefined, (event) => { runLog.insertEvent(runId, seq, event); seq += 1; if (event.type === "error") errorMessage = event.message; });
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      logger.error({ err, slug, runId }, "Builder prompt stream failed");
    }

    if (errorMessage !== undefined) {
      runLog.finishRun(runId, "error", { error: errorMessage });
      return { slug, runId, commitSha: "", status: "error", error: errorMessage };
    }

    let commitSha: string;
    try {
      gitInWorktree(worktree.path, ["add", "-A"]);
      gitInWorktree(worktree.path, ["commit", "--allow-empty", "-m", `build: ${slug}`]);
      commitSha = gitInWorktree(worktree.path, ["rev-parse", "HEAD"]).trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, slug, runId }, "Builder commit failed");
      runLog.finishRun(runId, "error", { error: `commit failed: ${msg}` });
      return { slug, runId, commitSha: "", status: "error", error: `commit failed: ${msg}` };
    }

    runLog.finishRun(runId, "done", { commitSha });
    logger.info({ slug, runId, commitSha }, "Builder run complete");
    return { slug, runId, commitSha, status: "built" };
  } finally {
    if (session) {
      try {
         if (supervisorSessionId) await supervisor.close(supervisorSessionId);
      } catch (err) {
        logger.warn({ err, slug }, "Failed to close builder session");
      }
    }
  }
}

export interface RunOnceOptions {
  root?: string;
  agent?: Agent;
  manager?: WorktreeManager;
  builderAgentId?: string;
  validatorAgentId?: string;
  maxRetries?: number;
  bus?: EventBus;
  machineDir?: string;
}

export interface ValidateTaskOptions {
  root?: string;
  agent?: Agent;
  manager?: WorktreeManager;
  validatorAgentId?: string;
  trunkRef?: string;
  bus?: EventBus;
  machineDir?: string;
}

export interface RenderValidatorPromptOptions {
  diffMaxLines?: number;
}

export function renderValidatorPrompt(
  task: Task,
  diff: string,
  trunkRef: string,
  totalDiffLines: number,
  options: RenderValidatorPromptOptions = {},
): string {
  const maxLines = options.diffMaxLines ?? DIFF_MAX_LINES;
  const truncatedNote =
    totalDiffLines > maxLines ? ` (truncated to ${maxLines} of ${totalDiffLines} lines)` : "";

  return [
    `You are validating the implementation of task "${task.title}" (slug: ${task.slug}).`,
    "",
    "## Spec",
    "",
    task.spec_markdown.trimEnd(),
    "",
    `## Diff${truncatedNote}`,
    "",
    `Base: ${trunkRef}`,
    `Run \`git diff ${trunkRef}...HEAD\` in this directory to see the full diff if needed.`,
    "",
    diff,
    "",
    "## Instructions",
    "",
    "1. Read the spec above carefully.",
    "2. Inspect the diff above. Run the project's test suite, type-check, and any other checks that match the spec's acceptance criteria. Use the file system and shell freely; you are in the build's worktree.",
    "3. Decide: do the changes satisfy the spec? Are the tests passing? Is the diff minimal and correct?",
    "4. When you have decided, output exactly one final line and stop:",
    "",
    "   MARSHAL_GATE: pass",
    "",
    "   or",
    "",
    "   MARSHAL_GATE: fail <one-sentence reason>",
    "",
  ].join("\n");
}

function computeTruncatedDiff(
  worktreePath: string,
  trunkRef: string,
): { diff: string; totalLines: number } {
  const raw = gitInWorktree(worktreePath, ["diff", `${trunkRef}...HEAD`, "--", ".", ":!specs"]);
  const lines = raw.split("\n");
  if (lines.length <= DIFF_MAX_LINES) {
    return { diff: raw, totalLines: lines.length };
  }
  const head = lines.slice(0, DIFF_MAX_LINES).join("\n");
  return { diff: head, totalLines: lines.length };
}

function lastBuilderCommitSha(slug: string, root?: string): string | null {
  const db = openDb(root);
  const row = db
    .prepare(
      `SELECT r.commit_sha AS commit_sha
         FROM runs r
         JOIN tasks t ON t.id = r.task_id
        WHERE t.slug = ? AND r.role = 'builder' AND r.status = 'done' AND r.commit_sha IS NOT NULL
        ORDER BY r.ended_at DESC, r.id DESC
        LIMIT 1`,
    )
    .get(slug) as BuildRunRow | undefined;
  return row?.commit_sha ?? null;
}

export async function validateTask(
  slug: string,
  options: ValidateTaskOptions = {},
): Promise<RunOnceResult> {
  const root = options.root;
  const task = getTask(slug, root);

  const manager = options.manager ?? new WorktreeManager(root ?? cwd());
   const resolved = workflowAssignment(task, "validator", options.machineDir);
   const validatorAgentId = options.validatorAgentId ?? resolved.assignment?.agent_id ?? (options.agent ? resolveAgentId("validator") : "test-validator");
   const validatorVersion = resolved.assignment?.agent_version ?? "legacy";
  const runLog = new RunLog(root, options.bus);

  const worktree = manager.create(slug);
  const buildCommit = lastBuilderCommitSha(slug, root);
  if (!buildCommit) {
    logger.warn({ slug }, "Validator pre-flight: no successful builder run found");
    return {
      slug,
      runId: 0,
      commitSha: "",
      status: "skipped",
      error: "no build commit to validate",
    };
  }

  const trunkRef = options.trunkRef ?? detectTrunkRef(worktree.path);
  let diffText: string;
  let totalDiffLines: number;
  try {
    const result = computeTruncatedDiff(worktree.path, trunkRef);
    diffText = result.diff;
    totalDiffLines = result.totalLines;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, slug }, "Validator diff computation failed");
    return {
      slug,
      runId: 0,
      commitSha: buildCommit,
      status: "skipped",
      error: `diff failed: ${msg}`,
    };
  }

  const prompt = renderValidatorPrompt(task, diffText, trunkRef, totalDiffLines);
   const runId = runLog.startRun(task.id, "validator", validatorAgentId, prompt, { agentVersion: validatorVersion, agentProvenance: resolved.assignment?.agent_provenance ?? historicalProvenance(validatorAgentId, validatorVersion), assignmentConfig: resolved.assignment ? { model: resolved.assignment.model, mode: resolved.assignment.mode, permission_policy: resolved.profile?.permission_policy } : {} });

  const spawnOpts: SpawnOptions = {
    sessionName: `marshal-${slug}-validator`,
    permissionMode: VALIDATOR_PERMISSION_MODE,
    timeoutSeconds: VALIDATOR_TIMEOUT_SECONDS,
  };

   let session: AgentSession | undefined;
   let supervisorSessionId: string | undefined;
   const seenEvents: AgentEvent[] = [];
   const supervisor = new AcpSessionSupervisor({ root, machineDir: options.machineDir, agent: options.agent, permissionPolicy: resolved.profile?.permission_policy, workflow: true, permissionMode: options.agent && !resolved.profile ? "approve-all" : undefined, bus: options.bus });
   const verification = runDeterministicVerification(resolved.profile?.verification_commands ?? [], worktree.path);
   runLog.setVerification(runId, verification.pass ? "pass" : "fail", verification.output);
   if (!verification.pass) {
     runLog.finishRun(runId, "error", { error: verification.output });
     return { slug, runId, commitSha: buildCommit, status: "validation_failed", reason: verification.output };
   }
  try {
    try {
       const started = await supervisor.start("workflow-run", String(runId), worktree.path, validatorAgentId, validatorVersion, { ...(resolved.assignment ? { model: resolved.assignment.model, mode: resolved.assignment.mode } : {}), sessionName: `marshal-${slug}-validator` });
        session = started.session;
        supervisorSessionId = started.record.id;
       runLog.setSupervisorEvidence(runId, { sessionId: started.record.id, capabilities: started.record.capabilities });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, slug, runId }, "Validator spawn failed");
      runLog.finishRun(runId, "error", { error: `spawn failed: ${msg}` });
      return {
        slug,
        runId,
        commitSha: buildCommit,
        status: "validation_failed",
        reason: `spawn failed: ${msg}`,
      };
    }

    let errorMessage: string | undefined;
    let seq = 0;
    try {
       await supervisor.prompt(supervisorSessionId, prompt, undefined, (event) => { runLog.insertEvent(runId, seq, event); seq += 1; seenEvents.push(event); if (event.type === "error") errorMessage = event.message; });
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      logger.error({ err, slug, runId }, "Validator prompt stream failed");
    }

    if (errorMessage !== undefined) {
      runLog.finishRun(runId, "error", { error: errorMessage });
      return {
        slug,
        runId,
        commitSha: buildCommit,
        status: "validation_failed",
        reason: errorMessage,
      };
    }

    const gate = parseGateSentinel(seenEvents);
    if (gate.result === "pass") {
      runLog.finishRun(runId, "done", { commitSha: buildCommit });
      logger.info({ slug, runId, commitSha: buildCommit }, "Validator passed");
      return { slug, runId, commitSha: buildCommit, status: "validated" };
    }

    const reason = gate.result === "fail" ? gate.reason : "no gate decision emitted";
    runLog.finishRun(runId, "error", { error: reason });
    logger.info({ slug, runId, reason }, "Validator failed");
    return {
      slug,
      runId,
      commitSha: buildCommit,
      status: "validation_failed",
      reason,
    };
  } finally {
    if (session) {
      try {
          if (supervisorSessionId) await supervisor.close(supervisorSessionId);
      } catch (err) {
        logger.warn({ err, slug }, "Failed to close validator session");
      }
    }
  }
}

function runDeterministicVerification(commands: string[], cwdPath: string): { pass: boolean; output: string } {
  if (commands.length === 0) return { pass: true, output: "no deterministic verification commands configured" };
  const outputs: string[] = [];
  for (const command of commands) {
    try { outputs.push(`$ ${command}\n${execFileSync("sh", ["-lc", command], { cwd: cwdPath, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })}`); }
    catch (err) { const detail = err instanceof Error ? err.message : String(err); return { pass: false, output: `$ ${command}\n${detail}` }; }
  }
  return { pass: true, output: outputs.join("\n") };
}

export async function runOnce(options: RunOnceOptions = {}): Promise<RunOnceResult | null> {
  const root = options.root;

  const db = openDb(root);
  const row = db
    .prepare(
      "SELECT slug, status FROM tasks WHERE status IN ('ready', 'validating') ORDER BY created_at ASC, id ASC LIMIT 1",
    )
    .get() as (ReadyTaskRow & { status: string }) | undefined;
  if (!row) {
    return null;
  }

  const slug = row.slug;
  const taskStatus = row.status;
  const task = getTask(slug, root);

  const manager = options.manager ?? new WorktreeManager(root ?? cwd());

  let worktree;
  try {
    worktree = manager.create(slug);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ slug, err }, "Pre-flight worktree lookup failed");
    return {
      slug,
      runId: 0,
      commitSha: "",
      status: "skipped",
      error: `worktree missing: ${msg}`,
    };
  }

  if (taskStatus === "ready") {
    const specRel = specRelPathFor(slug, task.id);
    const specAbs = resolve(worktree.path, specRel);
    if (!existsSync(specAbs)) {
      logger.warn({ slug, specRel }, "Pre-flight frozen spec file missing");
      return {
        slug,
        runId: 0,
        commitSha: "",
        status: "skipped",
        error: `frozen spec missing: ${specRel}`,
      };
    }

    transitionAndPublish(slug, "ready", "building", root, options.bus);

    const result = await buildTask(slug, {
      root,
      agent: options.agent,
      manager,
      builderAgentId: options.builderAgentId,
      bus: options.bus,
      machineDir: options.machineDir,
    });

    if (result.status === "built") {
      transitionAndPublish(slug, "building", "validating", root, options.bus);
    }

    return result;
  }

  // taskStatus === "validating"
  const result = await validateTask(slug, {
    root,
    agent: options.agent,
    manager,
      validatorAgentId: options.validatorAgentId,
      bus: options.bus,
      machineDir: options.machineDir,
  });

  if (result.status === "validated") {
    clearRetryState(slug, root);
    transitionAndPublish(slug, "validating", "review", root, options.bus);
  } else if (result.status === "validation_failed") {
    const maxRetries = options.maxRetries ?? resolveMaxRetries();
    const reason = result.reason ?? result.error ?? "unknown validation failure";
    if (task.retry_count < maxRetries) {
      incrementRetryCount(slug, reason, root);
      transitionAndPublish(slug, "validating", "building", root, options.bus);
    } else {
      setLastFailure(slug, reason, root);
      transitionAndPublish(slug, "validating", "review", root, options.bus);
    }
  }

  return result;
}

function transitionAndPublish(
  slug: string,
  from: string,
  to: TaskStatus,
  root?: string,
  bus?: EventBus,
): void {
  const task = transitionTask(slug, to, root);
  if (bus) {
    publishTaskTransitioned(bus, taskCardPayload(task), from, to);
  }
}

function taskCardPayload(task: Task): {
  id: number;
  slug: string;
  title: string;
  status: string;
  retry_count: number;
  created_at: string;
  updated_at: string;
} {
  return {
    id: task.id,
    slug: task.slug,
    title: task.title,
    status: task.status,
    retry_count: task.retry_count,
    created_at: task.created_at,
    updated_at: task.updated_at,
  };
}
