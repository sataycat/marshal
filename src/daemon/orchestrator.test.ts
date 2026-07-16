import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  Agent,
  AgentEvent,
  AgentId,
  AgentSession,
  PromptOptions,
  SpawnOptions,
} from "../agent/types.js";
import { WorktreeManager } from "../worktree/manager.js";
import { createTask, getTask, transitionTask } from "../tasks/store.js";
import { freezeTask } from "../tasks/freeze.js";
import { RunLog } from "./run-log.js";
import {
  DaemonCycleCompleteType,
  DaemonIdleType,
  EventBus,
  RunEventType,
  RunFinishedType,
  RunStartedType,
  TaskTransitionedType,
} from "./bus.js";
import { startDaemon } from "./loop.js";
import {
  buildTask,
  detectTrunkRef,
  NoTrunkRefError,
  parseGateSentinel,
  renderBuilderPrompt,
  renderValidatorPrompt,
  runOnce,
  validateTask,
} from "./orchestrator.js";

function initGitRepo(root: string): void {
  execSync("git init -b main", { cwd: root, stdio: "ignore" });
  execSync("git config user.email test@example.com", { cwd: root, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: root, stdio: "ignore" });
  writeFileSync(join(root, "README.md"), "# Test\n");
  execSync("git add README.md", { cwd: root, stdio: "ignore" });
  execSync("git commit -m init", { cwd: root, stdio: "ignore" });
}

function initMarshalState(root: string): void {
  mkdirSync(join(root, ".marshal"), { recursive: true });
}

function initAgentConfig(root: string): void {
  const cfgPath = join(root, ".marshal", "config.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({
      agents: {
        builder: { id: "opencode", command: "opencode", args: ["acp"] },
        validator: { id: "pi", command: "pi-acp", args: [] },
        specAuthor: { id: "opencode", command: "opencode", args: ["acp"] },
      },
    }),
  );
  process.env.MARSHAL_GLOBAL_CONFIG = cfgPath;
}

function gitHead(worktreePath: string): string {
  return execSync("git rev-parse HEAD", { cwd: worktreePath, encoding: "utf8" }).trim();
}

function gitLogSubject(worktreePath: string): string {
  return execSync("git log --format=%s -1", { cwd: worktreePath, encoding: "utf8" }).trim();
}

function gitStatusPorcelain(worktreePath: string): string {
  return execSync("git status --porcelain=v1", { cwd: worktreePath, encoding: "utf8" }).trim();
}

interface FakeAgentConfig {
  events?: AgentEvent[];
  onSpawn?: (session: AgentSession) => void;
  spawnThrows?: Error;
}

class FakeAgent implements Agent {
  spawnCalls: { cwd: string; agentId: AgentId; opts: SpawnOptions }[] = [];
  promptCalls: { session: AgentSession; text: string; opts: PromptOptions }[] = [];
  closeCalls: AgentSession[] = [];
  cancelCalls: AgentSession[] = [];
  private config: FakeAgentConfig;

  constructor(config: FakeAgentConfig = {}) {
    this.config = config;
  }

  async spawn(cwd: string, agentId: AgentId, opts: SpawnOptions = {}): Promise<AgentSession> {
    this.spawnCalls.push({ cwd, agentId, opts });
    if (this.config.spawnThrows) {
      throw this.config.spawnThrows;
    }
    const session: AgentSession = {
      agentId,
      cwd,
      name: opts.sessionName ?? `marshal-${agentId}`,
      recordId: "fake-rec",
    };
    if (this.config.onSpawn) {
      this.config.onSpawn(session);
    }
    return session;
  }

  async *prompt(
    session: AgentSession,
    text: string,
    opts: PromptOptions = {},
  ): AsyncGenerator<AgentEvent> {
    this.promptCalls.push({ session, text, opts });
    const events = this.config.events ?? [{ type: "done", stopReason: "end_turn" }];
    for (const ev of events) {
      yield ev;
    }
  }

  async cancel(session: AgentSession): Promise<void> {
    this.cancelCalls.push(session);
  }

  async close(session: AgentSession): Promise<void> {
    this.closeCalls.push(session);
  }
}

describe("renderBuilderPrompt", () => {
  it("inlines the task title, slug, and spec_markdown verbatim", () => {
    const task = createTask(
      {
        slug: "add-thing",
        title: "Add the thing",
        specMarkdown: "## Goal\nMake it work.\n\n## Steps\n1. Do x\n2. Do y\n",
      },
      mkdtempSync(join(tmpdir(), "marshal-prompt-")),
    );

    const prompt = renderBuilderPrompt(task);

    expect(prompt).toContain('task "Add the thing" (slug: add-thing)');
    expect(prompt).toContain("## Spec");
    expect(prompt).toContain("Make it work.");
    expect(prompt).toContain("1. Do x");
    expect(prompt).toContain("## Instructions");
    expect(prompt).toContain("Do not commit");
    expect(prompt).toContain("Run type-checks and tests before finishing");
  });

  it("does not include a spec file path that would tempt a tool call", () => {
    const task = createTask(
      { slug: "no-path", title: "No Path", specMarkdown: "body" },
      mkdtempSync(join(tmpdir(), "marshal-prompt-")),
    );
    const prompt = renderBuilderPrompt(task);
    expect(prompt).not.toMatch(/specs\/\d{4}-no-path\.md/);
  });
});

describe("runOnce", () => {
  let repoRoot: string;
  let worktreeRoot: string;
  let manager: WorktreeManager;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "marshal-repo-"));
    worktreeRoot = mkdtempSync(join(tmpdir(), "marshal-worktrees-"));
    initGitRepo(repoRoot);
    initMarshalState(repoRoot);
    initAgentConfig(repoRoot);
    manager = new WorktreeManager(repoRoot, { worktreeRoot });
  });

  afterEach(() => {
    delete process.env.MARSHAL_GLOBAL_CONFIG;
  });

  function createReadyFrozenTask(slug: string, specMarkdown: string) {
    const task = createTask({ slug, title: `Task ${slug}`, specMarkdown }, repoRoot);
    transitionTask(slug, "ready", repoRoot);
    freezeTask(slug, repoRoot, manager);
    return task;
  }

  it("returns null when no ready task exists", async () => {
    const agent = new FakeAgent();
    const result = await runOnce({ root: repoRoot, agent, manager });
    expect(result).toBeNull();
    expect(agent.spawnCalls).toHaveLength(0);
  });

  it("claims a ready task, builds, commits, and transitions to validating", async () => {
    const agent = new FakeAgent({
      events: [
        { type: "text", text: "Working on it" },
        { type: "tool", title: "Write file", status: "completed" },
        { type: "done", stopReason: "end_turn" },
      ],
      onSpawn: (session) => {
        mkdirSync(join(session.cwd, "src"), { recursive: true });
        writeFileSync(join(session.cwd, "src", "feature.ts"), "export const x = 1;\n");
      },
    });

    const task = createReadyFrozenTask("happy-path", "## Goal\nBuild the feature.\n");

    const result = await runOnce({ root: repoRoot, agent, manager });

    expect(result).not.toBeNull();
    expect(result?.status).toBe("built");
    expect(result?.slug).toBe("happy-path");
    expect(result?.runId).toBeGreaterThan(0);
    expect(result?.commitSha).toMatch(/^[0-9a-f]{40}$/);

    expect(getTask("happy-path", repoRoot).status).toBe("validating");

    expect(agent.spawnCalls).toHaveLength(1);
    expect(agent.spawnCalls[0].agentId).toBe("opencode");
    expect(agent.spawnCalls[0].opts.sessionName).toBe("marshal-happy-path-builder");
    expect(agent.spawnCalls[0].opts.permissionMode).toBe("approve-all");
    expect(agent.spawnCalls[0].cwd).toBe(manager.create("happy-path").path);

    expect(agent.closeCalls).toHaveLength(1);

    const worktree = manager.create("happy-path");
    expect(gitLogSubject(worktree.path)).toBe("build: happy-path");
    expect(gitHead(worktree.path)).toBe(result?.commitSha);
    expect(existsSync(join(worktree.path, "src", "feature.ts"))).toBe(true);
    expect(gitStatusPorcelain(worktree.path)).toBe("");

    const log = new RunLog(repoRoot);
    const run = log.getRun(result!.runId);
    expect(run?.status).toBe("done");
    expect(run?.role).toBe("builder");
    expect(run?.agentId).toBe("opencode");
    expect(run?.commitSha).toBe(result?.commitSha);
    expect(run?.endedAt).not.toBeNull();

    const events = log.getEvents(result!.runId);
    expect(events.map((e) => e.type)).toEqual(["text", "tool", "done"]);
  });

  it("stores the rendered prompt in the run log", async () => {
    const agent = new FakeAgent();
    createReadyFrozenTask("prompt-stored", "## Goal\nDo stuff.\n");

    const result = await runOnce({ root: repoRoot, agent, manager });

    expect(result?.status).toBe("built");

    const log = new RunLog(repoRoot);
    const run = log.getRun(result!.runId);
    expect(run?.prompt).toContain('task "Task prompt-stored" (slug: prompt-stored)');
    expect(run?.prompt).toContain("Do stuff.");
    expect(run?.prompt).toContain("Do not commit");

    expect(agent.promptCalls).toHaveLength(1);
    expect(agent.promptCalls[0].text).toBe(run?.prompt);
  });

  it("commits with --allow-empty when the builder made no changes", async () => {
    const agent = new FakeAgent({
      events: [{ type: "done", stopReason: "end_turn" }],
    });

    createReadyFrozenTask("no-changes", "## Goal\nAlready done.\n");
    const freezeResult = freezeTask("no-changes", repoRoot, manager);
    const freezeHead = freezeResult.commitSha;

    const result = await runOnce({ root: repoRoot, agent, manager });

    expect(result?.status).toBe("built");

    const worktree = manager.create("no-changes");
    expect(gitLogSubject(worktree.path)).toBe("build: no-changes");
    expect(gitHead(worktree.path)).not.toBe(freezeHead);
  });

  it("leaves the task in building and records error when the agent emits an error event", async () => {
    const agent = new FakeAgent({
      events: [
        { type: "text", text: "halfway" },
        { type: "error", message: "agent crashed", code: 1 },
      ],
    });

    createReadyFrozenTask("error-event", "## Goal\nFail.\n");
    const freezeResult = freezeTask("error-event", repoRoot, manager);
    const freezeHead = freezeResult.commitSha;

    const result = await runOnce({ root: repoRoot, agent, manager });

    expect(result?.status).toBe("error");
    expect(result?.slug).toBe("error-event");
    expect(result?.error).toBe("agent crashed");
    expect(result?.commitSha).toBe("");
    expect(result?.runId).toBeGreaterThan(0);

    expect(getTask("error-event", repoRoot).status).toBe("building");

    const worktree = manager.create("error-event");
    expect(gitHead(worktree.path)).toBe(freezeHead);
    expect(gitLogSubject(worktree.path)).toBe("freeze: error-event");

    const log = new RunLog(repoRoot);
    const run = log.getRun(result!.runId);
    expect(run?.status).toBe("error");
    expect(run?.error).toBe("agent crashed");
    expect(run?.commitSha).toBeNull();
    expect(run?.endedAt).not.toBeNull();

    const events = log.getEvents(result!.runId);
    expect(events.map((e) => e.type)).toEqual(["text", "error"]);

    expect(agent.closeCalls).toHaveLength(1);
  });

  it("records an error run and leaves task in building when spawn throws", async () => {
    const agent = new FakeAgent({
      spawnThrows: new Error("acpx not installed"),
    });

    createReadyFrozenTask("spawn-fails", "## Goal\nNo agent.\n");

    const result = await runOnce({ root: repoRoot, agent, manager });

    expect(result?.status).toBe("error");
    expect(result?.slug).toBe("spawn-fails");
    expect(result?.error).toMatch(/spawn failed: acpx not installed/);
    expect(result?.commitSha).toBe("");
    expect(result?.runId).toBeGreaterThan(0);

    expect(getTask("spawn-fails", repoRoot).status).toBe("building");

    const log = new RunLog(repoRoot);
    const run = log.getRun(result!.runId);
    expect(run?.status).toBe("error");
    expect(run?.error).toMatch(/spawn failed/);
    expect(run?.commitSha).toBeNull();
    expect(log.getEvents(result!.runId)).toEqual([]);

    expect(agent.closeCalls).toHaveLength(0);
  });

  it("skips without claiming when the frozen spec file is missing", async () => {
    createTask({ slug: "not-frozen", title: "Not Frozen", specMarkdown: "## Goal\nx\n" }, repoRoot);
    transitionTask("not-frozen", "ready", repoRoot);

    const agent = new FakeAgent();
    const result = await runOnce({ root: repoRoot, agent, manager });

    expect(result?.status).toBe("skipped");
    expect(result?.slug).toBe("not-frozen");
    expect(result?.error).toMatch(/frozen spec missing/);
    expect(result?.runId).toBe(0);
    expect(result?.commitSha).toBe("");

    expect(getTask("not-frozen", repoRoot).status).toBe("ready");
    expect(agent.spawnCalls).toHaveLength(0);
  });

  it("picks the oldest ready task (FIFO by created_at, id)", async () => {
    createReadyFrozenTask("older-task", "## Goal\nFirst.\n");
    createReadyFrozenTask("newer-task", "## Goal\nSecond.\n");

    const agent = new FakeAgent();
    const result = await runOnce({ root: repoRoot, agent, manager });

    expect(result?.slug).toBe("older-task");
    expect(getTask("older-task", repoRoot).status).toBe("validating");
    expect(getTask("newer-task", repoRoot).status).toBe("ready");
  });

  // ADR-023 Decision 2 regression test: the builder path must resolve its
  // agent id via resolveAgentId("builder"), not a hard-coded constant.
  it("uses resolveAgentId('builder') for the builder agent, not a hard-coded constant", async () => {
    writeFileSync(
      process.env.MARSHAL_GLOBAL_CONFIG!,
      JSON.stringify({
        agents: {
          builder: { id: "codex", command: "codex-acp", args: [] },
          validator: { id: "pi", command: "pi-acp", args: [] },
          specAuthor: { id: "opencode", command: "opencode", args: ["acp"] },
        },
      }),
    );
    const agent = new FakeAgent({
      events: [{ type: "done", stopReason: "end_turn" }],
      onSpawn: (session) => {
        mkdirSync(join(session.cwd, "src"), { recursive: true });
        writeFileSync(join(session.cwd, "src", "feature.ts"), "export const x = 1;\n");
      },
    });
    createReadyFrozenTask("builder-resolve", "## Goal\nResolve builder.\n");

    const result = await runOnce({ root: repoRoot, agent, manager });

    expect(result?.status).toBe("built");
    expect(agent.spawnCalls[0].agentId).toBe("codex");

    const log = new RunLog(repoRoot);
    expect(log.getRun(result!.runId)?.agentId).toBe("codex");
  });
});

describe("buildTask", () => {
  let repoRoot: string;
  let worktreeRoot: string;
  let manager: WorktreeManager;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "marshal-repo-"));
    worktreeRoot = mkdtempSync(join(tmpdir(), "marshal-worktrees-"));
    initGitRepo(repoRoot);
    initMarshalState(repoRoot);
    initAgentConfig(repoRoot);
    manager = new WorktreeManager(repoRoot, { worktreeRoot });
  });

  afterEach(() => {
    delete process.env.MARSHAL_GLOBAL_CONFIG;
  });

  it("builds a task already in building state without re-claiming", async () => {
    createTask(
      { slug: "direct-build", title: "Direct", specMarkdown: "## Goal\nDirect build.\n" },
      repoRoot,
    );
    transitionTask("direct-build", "ready", repoRoot);
    freezeTask("direct-build", repoRoot, manager);
    transitionTask("direct-build", "building", repoRoot);

    const agent = new FakeAgent({
      events: [{ type: "done", stopReason: "end_turn" }],
    });

    const result = await buildTask("direct-build", { root: repoRoot, agent, manager });

    expect(result.status).toBe("built");
    expect(result.slug).toBe("direct-build");
    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);

    expect(getTask("direct-build", repoRoot).status).toBe("building");

    const worktree = manager.create("direct-build");
    expect(gitLogSubject(worktree.path)).toBe("build: direct-build");
  });
});

describe("parseGateSentinel", () => {
  it("returns pass on a MARSHAL_GATE: pass text event", () => {
    const result = parseGateSentinel([{ type: "text", text: "All good.\nMARSHAL_GATE: pass\n" }]);
    expect(result).toEqual({ result: "pass" });
  });

  it("returns fail with reason on MARSHAL_GATE: fail <reason>", () => {
    const result = parseGateSentinel([
      { type: "text", text: "Tests are broken.\nMARSHAL_GATE: fail tests are red\n" },
    ]);
    expect(result).toEqual({ result: "fail", reason: "tests are red" });
  });

  it("returns fail with a placeholder reason when none is given", () => {
    const result = parseGateSentinel([{ type: "text", text: "MARSHAL_GATE: fail\n" }]);
    expect(result).toEqual({ result: "fail", reason: "no reason given" });
  });

  it("returns absent when no sentinel is seen", () => {
    const result = parseGateSentinel([
      { type: "text", text: "I forgot to emit a gate." },
      { type: "done", stopReason: "end_turn" },
    ]);
    expect(result).toEqual({ result: "absent" });
  });

  it("ignores non-text events", () => {
    const result = parseGateSentinel([
      { type: "tool", title: "write" },
      { type: "log", stream: "stdout", text: "MARSHAL_GATE: pass" },
      { type: "done", stopReason: "end_turn" },
    ]);
    expect(result).toEqual({ result: "absent" });
  });

  it("first well-formed line wins when both pass and fail appear", () => {
    const result = parseGateSentinel([
      { type: "text", text: "MARSHAL_GATE: pass\nNever mind.\nMARSHAL_GATE: fail too late\n" },
    ]);
    expect(result).toEqual({ result: "pass" });
  });

  it("is case-sensitive on the sentinel", () => {
    const result = parseGateSentinel([{ type: "text", text: "marshal_gate: pass\n" }]);
    expect(result).toEqual({ result: "absent" });
  });
});

describe("renderValidatorPrompt", () => {
  function makeTask() {
    return createTask(
      { slug: "v-task", title: "Validator Task", specMarkdown: "## Goal\nBe correct.\n" },
      mkdtempSync(join(tmpdir(), "marshal-vprompt-")),
    );
  }

  it("inlines the spec, diff, trunk ref, and sentinel instructions", () => {
    const task = makeTask();
    const prompt = renderValidatorPrompt(task, "+added line\n-old line\n", "main", 2);

    expect(prompt).toContain(
      'validating the implementation of task "Validator Task" (slug: v-task)',
    );
    expect(prompt).toContain("## Spec");
    expect(prompt).toContain("Be correct.");
    expect(prompt).toContain("## Diff");
    expect(prompt).toContain("Base: main");
    expect(prompt).toContain("`git diff main...HEAD`");
    expect(prompt).toContain("+added line");
    expect(prompt).toContain("-old line");
    expect(prompt).toContain("MARSHAL_GATE: pass");
    expect(prompt).toContain("MARSHAL_GATE: fail <one-sentence reason>");
  });

  it("annotates the diff when it is truncated", () => {
    const task = makeTask();
    const prompt = renderValidatorPrompt(task, "stub", "main", 5000, { diffMaxLines: 2000 });
    expect(prompt).toContain("(truncated to 2000 of 5000 lines)");
  });

  it("omits the truncation note when the diff fits", () => {
    const task = makeTask();
    const prompt = renderValidatorPrompt(task, "stub", "main", 100, { diffMaxLines: 2000 });
    expect(prompt).not.toMatch(/truncated/);
  });
});

describe("detectTrunkRef", () => {
  it("finds the local main branch in a fresh repo", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "marshal-trunk-"));
    initGitRepo(repoRoot);
    const worktreeRoot = mkdtempSync(join(tmpdir(), "marshal-trunk-wt-"));
    const manager = new WorktreeManager(repoRoot, { worktreeRoot });
    const task = createTask({ slug: "trunk-task", title: "T", specMarkdown: "x" }, repoRoot);
    transitionTask("trunk-task", "ready", repoRoot);
    freezeTask("trunk-task", repoRoot, manager);
    transitionTask("trunk-task", "building", repoRoot);
    transitionTask("trunk-task", "validating", repoRoot);
    const worktree = manager.create("trunk-task");

    expect(detectTrunkRef(worktree.path)).toBe("main");
  });

  it("throws NoTrunkRefError when no trunk ref exists", () => {
    const empty = mkdtempSync(join(tmpdir(), "marshal-empty-"));
    expect(() => detectTrunkRef(empty)).toThrow(NoTrunkRefError);
  });
});

function createValidatedReadyTask(
  slug: string,
  specMarkdown: string,
  repoRoot: string,
  manager: WorktreeManager,
) {
  const task = createTask({ slug, title: `Task ${slug}`, specMarkdown }, repoRoot);
  transitionTask(slug, "ready", repoRoot);
  freezeTask(slug, repoRoot, manager);
  transitionTask(slug, "building", repoRoot);
  transitionTask(slug, "validating", repoRoot);
  return task;
}

describe("validateTask", () => {
  let repoRoot: string;
  let worktreeRoot: string;
  let manager: WorktreeManager;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "marshal-repo-"));
    worktreeRoot = mkdtempSync(join(tmpdir(), "marshal-worktrees-"));
    initGitRepo(repoRoot);
    initMarshalState(repoRoot);
    initAgentConfig(repoRoot);
    manager = new WorktreeManager(repoRoot, { worktreeRoot });
  });

  afterEach(() => {
    delete process.env.MARSHAL_GLOBAL_CONFIG;
  });

  it("validates a task in validating state, returns validated, leaves task in validating", async () => {
    createValidatedReadyTask("gate-pass", "## Goal\nDo it.\n", repoRoot, manager);

    const worktree = manager.create("gate-pass");
    mkdirSync(join(worktree.path, "src"), { recursive: true });
    writeFileSync(join(worktree.path, "src", "feature.ts"), "export const x = 1;\n");
    execSync("git add -A && git commit -m 'build: gate-pass' --allow-empty", {
      cwd: worktree.path,
      stdio: "ignore",
    });
    const buildCommit = execSync("git rev-parse HEAD", {
      cwd: worktree.path,
      encoding: "utf8",
    }).trim();
    // Record the build run so validateTask can find the build commit.
    const log = new RunLog(repoRoot);
    const task = getTask("gate-pass", repoRoot);
    const runId = log.startRun(task.id, "builder", "opencode", "build prompt");
    log.finishRun(runId, "done", { commitSha: buildCommit });

    const agent = new FakeAgent({
      events: [
        { type: "text", text: "Looking at the diff...\n" },
        { type: "tool", title: "read", status: "completed" },
        { type: "text", text: "Looks good.\nMARSHAL_GATE: pass\n" },
        { type: "done", stopReason: "end_turn" },
      ],
    });

    const result = await validateTask("gate-pass", {
      root: repoRoot,
      agent,
      manager,
      trunkRef: "main",
    });

    expect(result.status).toBe("validated");
    expect(result.slug).toBe("gate-pass");
    expect(result.commitSha).toBe(buildCommit);
    expect(result.runId).toBeGreaterThan(0);
    expect(result.reason).toBeUndefined();

    expect(getTask("gate-pass", repoRoot).status).toBe("validating");

    expect(agent.spawnCalls).toHaveLength(1);
    expect(agent.spawnCalls[0].agentId).toBe("pi");
    expect(agent.spawnCalls[0].opts.sessionName).toBe("marshal-gate-pass-validator");
    expect(agent.spawnCalls[0].opts.permissionMode).toBe("approve-all");
    expect(agent.spawnCalls[0].cwd).toBe(worktree.path);

    expect(agent.promptCalls[0].text).toContain("## Spec");
    expect(agent.promptCalls[0].text).toContain("## Diff");
    expect(agent.promptCalls[0].text).toContain("Base: main");
    expect(agent.promptCalls[0].text).toContain("src/feature.ts");
    expect(agent.promptCalls[0].text).toContain("MARSHAL_GATE: pass");

    expect(agent.closeCalls).toHaveLength(1);

    const validatorLog = new RunLog(repoRoot);
    const validatorRun = validatorLog.getRun(result.runId);
    expect(validatorRun?.role).toBe("validator");
    expect(validatorRun?.agentId).toBe("pi");
    expect(validatorRun?.status).toBe("done");
    expect(validatorRun?.commitSha).toBe(buildCommit);
    expect(validatorRun?.endedAt).not.toBeNull();

    const events = validatorLog.getEvents(result.runId);
    expect(events.map((e) => e.type)).toEqual(["text", "tool", "text", "done"]);
  });

  it("uses the configured validator agent id", async () => {
    createValidatedReadyTask("gate-custom", "## Goal\nDo it.\n", repoRoot, manager);
    const worktree = manager.create("gate-custom");
    execSync("git add -A && git commit -m 'build: gate-custom' --allow-empty", {
      cwd: worktree.path,
      stdio: "ignore",
    });
    const buildCommit = execSync("git rev-parse HEAD", {
      cwd: worktree.path,
      encoding: "utf8",
    }).trim();
    const log = new RunLog(repoRoot);
    const task = getTask("gate-custom", repoRoot);
    const runId = log.startRun(task.id, "builder", "opencode", "build prompt");
    log.finishRun(runId, "done", { commitSha: buildCommit });

    const agent = new FakeAgent({
      events: [
        { type: "text", text: "MARSHAL_GATE: pass\n" },
        { type: "done", stopReason: "end_turn" },
      ],
    });

    const result = await validateTask("gate-custom", {
      root: repoRoot,
      agent,
      manager,
      trunkRef: "main",
      validatorAgentId: "opencode",
    });

    expect(result.status).toBe("validated");
    expect(agent.spawnCalls[0].agentId).toBe("opencode");
    expect(agent.spawnCalls[0].opts.sessionName).toBe("marshal-gate-custom-validator");

    const validatorLog = new RunLog(repoRoot);
    expect(validatorLog.getRun(result.runId)?.agentId).toBe("opencode");
  });

  it("returns validation_failed with reason on a fail sentinel", async () => {
    createValidatedReadyTask("gate-fail", "## Goal\nDo it.\n", repoRoot, manager);
    const worktree = manager.create("gate-fail");
    execSync("git add -A && git commit -m 'build: gate-fail' --allow-empty", {
      cwd: worktree.path,
      stdio: "ignore",
    });
    const buildCommit = execSync("git rev-parse HEAD", {
      cwd: worktree.path,
      encoding: "utf8",
    }).trim();
    const log = new RunLog(repoRoot);
    const task = getTask("gate-fail", repoRoot);
    const runId = log.startRun(task.id, "builder", "opencode", "build prompt");
    log.finishRun(runId, "done", { commitSha: buildCommit });

    const agent = new FakeAgent({
      events: [
        { type: "text", text: "Test suite is broken.\nMARSHAL_GATE: fail tests are red\n" },
        { type: "done", stopReason: "end_turn" },
      ],
    });

    const result = await validateTask("gate-fail", {
      root: repoRoot,
      agent,
      manager,
      trunkRef: "main",
    });

    expect(result.status).toBe("validation_failed");
    expect(result.reason).toBe("tests are red");
    expect(result.commitSha).toBe(buildCommit);

    expect(getTask("gate-fail", repoRoot).status).toBe("validating");

    const validatorLog = new RunLog(repoRoot);
    expect(validatorLog.getRun(result.runId)?.status).toBe("error");
    expect(validatorLog.getRun(result.runId)?.error).toBe("tests are red");
  });

  it("returns validation_failed with 'no gate decision emitted' when the agent never emits a sentinel", async () => {
    createValidatedReadyTask("gate-absent", "## Goal\nDo it.\n", repoRoot, manager);
    const worktree = manager.create("gate-absent");
    execSync("git add -A && git commit -m 'build: gate-absent' --allow-empty", {
      cwd: worktree.path,
      stdio: "ignore",
    });
    const buildCommit = execSync("git rev-parse HEAD", {
      cwd: worktree.path,
      encoding: "utf8",
    }).trim();
    const log = new RunLog(repoRoot);
    const task = getTask("gate-absent", repoRoot);
    const runId = log.startRun(task.id, "builder", "opencode", "build prompt");
    log.finishRun(runId, "done", { commitSha: buildCommit });

    const agent = new FakeAgent({
      events: [
        { type: "text", text: "I forgot to emit a gate line." },
        { type: "done", stopReason: "end_turn" },
      ],
    });

    const result = await validateTask("gate-absent", {
      root: repoRoot,
      agent,
      manager,
      trunkRef: "main",
    });

    expect(result.status).toBe("validation_failed");
    expect(result.reason).toBe("no gate decision emitted");
  });

  it("returns validation_failed when the agent emits an error event", async () => {
    createValidatedReadyTask("gate-error", "## Goal\nDo it.\n", repoRoot, manager);
    const worktree = manager.create("gate-error");
    execSync("git add -A && git commit -m 'build: gate-error' --allow-empty", {
      cwd: worktree.path,
      stdio: "ignore",
    });
    const buildCommit = execSync("git rev-parse HEAD", {
      cwd: worktree.path,
      encoding: "utf8",
    }).trim();
    const log = new RunLog(repoRoot);
    const task = getTask("gate-error", repoRoot);
    const runId = log.startRun(task.id, "builder", "opencode", "build prompt");
    log.finishRun(runId, "done", { commitSha: buildCommit });

    const agent = new FakeAgent({
      events: [
        { type: "text", text: "starting...\n" },
        { type: "error", message: "validator crashed", code: 1 },
      ],
    });

    const result = await validateTask("gate-error", {
      root: repoRoot,
      agent,
      manager,
      trunkRef: "main",
    });

    expect(result.status).toBe("validation_failed");
    expect(result.reason).toBe("validator crashed");
  });

  it("returns validation_failed when the agent spawn throws", async () => {
    createValidatedReadyTask("gate-spawn", "## Goal\nDo it.\n", repoRoot, manager);
    const worktree = manager.create("gate-spawn");
    execSync("git add -A && git commit -m 'build: gate-spawn' --allow-empty", {
      cwd: worktree.path,
      stdio: "ignore",
    });
    const buildCommit = execSync("git rev-parse HEAD", {
      cwd: worktree.path,
      encoding: "utf8",
    }).trim();
    const log = new RunLog(repoRoot);
    const task = getTask("gate-spawn", repoRoot);
    const runId = log.startRun(task.id, "builder", "opencode", "build prompt");
    log.finishRun(runId, "done", { commitSha: buildCommit });

    const agent = new FakeAgent({ spawnThrows: new Error("acpx not installed") });

    const result = await validateTask("gate-spawn", {
      root: repoRoot,
      agent,
      manager,
      trunkRef: "main",
    });

    expect(result.status).toBe("validation_failed");
    expect(result.reason).toMatch(/spawn failed: acpx not installed/);
    expect(agent.closeCalls).toHaveLength(0);
  });

  it("skips when there is no successful builder run to validate", async () => {
    createTask({ slug: "no-build", title: "No build", specMarkdown: "## Goal\nx\n" }, repoRoot);
    transitionTask("no-build", "ready", repoRoot);
    freezeTask("no-build", repoRoot, manager);
    transitionTask("no-build", "building", repoRoot);
    transitionTask("no-build", "validating", repoRoot);

    const agent = new FakeAgent();
    const result = await validateTask("no-build", {
      root: repoRoot,
      agent,
      manager,
      trunkRef: "main",
    });

    expect(result.status).toBe("skipped");
    expect(result.error).toMatch(/no build commit to validate/);
    expect(agent.spawnCalls).toHaveLength(0);
  });
});

describe("runOnce (validator dispatch)", () => {
  let repoRoot: string;
  let worktreeRoot: string;
  let manager: WorktreeManager;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "marshal-repo-"));
    worktreeRoot = mkdtempSync(join(tmpdir(), "marshal-worktrees-"));
    initGitRepo(repoRoot);
    initMarshalState(repoRoot);
    initAgentConfig(repoRoot);
    manager = new WorktreeManager(repoRoot, { worktreeRoot });
  });

  afterEach(() => {
    delete process.env.MARSHAL_GLOBAL_CONFIG;
  });

  function seedValidatingTask(
    slug: string,
    specMarkdown: string,
    repoRoot: string,
    manager: WorktreeManager,
  ) {
    const task = createTask({ slug, title: `Task ${slug}`, specMarkdown }, repoRoot);
    transitionTask(slug, "ready", repoRoot);
    freezeTask(slug, repoRoot, manager);
    transitionTask(slug, "building", repoRoot);
    transitionTask(slug, "validating", repoRoot);

    const worktree = manager.create(slug);
    execSync(`git add -A && git commit -m 'build: ${slug}' --allow-empty`, {
      cwd: worktree.path,
      stdio: "ignore",
    });
    const buildCommit = execSync("git rev-parse HEAD", {
      cwd: worktree.path,
      encoding: "utf8",
    }).trim();

    const log = new RunLog(repoRoot);
    const runId = log.startRun(task.id, "builder", "opencode", "build prompt");
    log.finishRun(runId, "done", { commitSha: buildCommit });
    return task;
  }

  it("returns null when no ready or validating task exists", async () => {
    const agent = new FakeAgent();
    const result = await runOnce({ root: repoRoot, agent, manager });
    expect(result).toBeNull();
  });

  it("picks the oldest validating task when no ready task exists, transitions pass -> review", async () => {
    seedValidatingTask("v-only", "## Goal\nv.\n", repoRoot, manager);

    const agent = new FakeAgent({
      events: [
        { type: "text", text: "MARSHAL_GATE: pass\n" },
        { type: "done", stopReason: "end_turn" },
      ],
    });

    const result = await runOnce({ root: repoRoot, agent, manager, validatorAgentId: "pi" });

    expect(result?.status).toBe("validated");
    expect(result?.slug).toBe("v-only");
    expect(getTask("v-only", repoRoot).status).toBe("review");
    expect(agent.spawnCalls[0].agentId).toBe("pi");
  });

  it("transitions validation_failed -> building on a fail sentinel", async () => {
    seedValidatingTask("v-fail", "## Goal\nv.\n", repoRoot, manager);

    const agent = new FakeAgent({
      events: [
        { type: "text", text: "MARSHAL_GATE: fail spec is not satisfied\n" },
        { type: "done", stopReason: "end_turn" },
      ],
    });

    const result = await runOnce({ root: repoRoot, agent, manager, validatorAgentId: "pi" });

    expect(result?.status).toBe("validation_failed");
    expect(result?.reason).toBe("spec is not satisfied");
    expect(getTask("v-fail", repoRoot).status).toBe("building");
  });

  it("transitions validation_failed -> building when no sentinel is emitted", async () => {
    seedValidatingTask("v-absent", "## Goal\nv.\n", repoRoot, manager);

    const agent = new FakeAgent({
      events: [{ type: "done", stopReason: "end_turn" }],
    });

    const result = await runOnce({ root: repoRoot, agent, manager, validatorAgentId: "pi" });

    expect(result?.status).toBe("validation_failed");
    expect(result?.reason).toBe("no gate decision emitted");
    expect(getTask("v-absent", repoRoot).status).toBe("building");
  });

  it("leaves the task in validating when spawn throws and routes to building", async () => {
    seedValidatingTask("v-spawn", "## Goal\nv.\n", repoRoot, manager);

    const agent = new FakeAgent({ spawnThrows: new Error("acpx missing") });

    const result = await runOnce({ root: repoRoot, agent, manager, validatorAgentId: "pi" });

    expect(result?.status).toBe("validation_failed");
    expect(result?.reason).toMatch(/spawn failed/);
    expect(getTask("v-spawn", repoRoot).status).toBe("building");
  });

  it("picks ready over validating when both exist (FIFO across statuses)", async () => {
    const ready = createTask(
      { slug: "ready-first", title: "R", specMarkdown: "## Goal\nr.\n" },
      repoRoot,
    );
    transitionTask("ready-first", "ready", repoRoot);
    freezeTask("ready-first", repoRoot, manager);
    seedValidatingTask("validating-second", "## Goal\nv.\n", repoRoot, manager);

    const agent = new FakeAgent({
      events: [
        { type: "text", text: "Working on it" },
        { type: "done", stopReason: "end_turn" },
      ],
      onSpawn: (session) => {
        mkdirSync(join(session.cwd, "src"), { recursive: true });
        writeFileSync(join(session.cwd, "src", "feature.ts"), "export const x = 1;\n");
      },
    });

    const result = await runOnce({ root: repoRoot, agent, manager, validatorAgentId: "pi" });

    expect(result?.slug).toBe("ready-first");
    expect(result?.status).toBe("built");
    expect(getTask("ready-first", repoRoot).status).toBe("validating");
    expect(getTask("validating-second", repoRoot).status).toBe("validating");
  });

  it("retries a failed validation up to the default cap, then escalates to review", async () => {
    seedValidatingTask("v-retry-cap", "## Goal\nv.\n", repoRoot, manager);

    const failAgent = new FakeAgent({
      events: [
        { type: "text", text: "MARSHAL_GATE: fail attempt\n" },
        { type: "done", stopReason: "end_turn" },
      ],
    });

    const first = await runOnce({
      root: repoRoot,
      agent: failAgent,
      manager,
      validatorAgentId: "pi",
    });
    expect(first?.status).toBe("validation_failed");
    expect(getTask("v-retry-cap", repoRoot).status).toBe("building");
    expect(getTask("v-retry-cap", repoRoot).retry_count).toBe(1);
    expect(getTask("v-retry-cap", repoRoot).last_failure).toBe("attempt");

    transitionTask("v-retry-cap", "validating", repoRoot);
    const second = await runOnce({
      root: repoRoot,
      agent: failAgent,
      manager,
      validatorAgentId: "pi",
    });
    expect(second?.status).toBe("validation_failed");
    expect(getTask("v-retry-cap", repoRoot).status).toBe("building");
    expect(getTask("v-retry-cap", repoRoot).retry_count).toBe(2);

    transitionTask("v-retry-cap", "validating", repoRoot);
    const third = await runOnce({
      root: repoRoot,
      agent: failAgent,
      manager,
      validatorAgentId: "pi",
    });
    expect(third?.status).toBe("validation_failed");
    expect(getTask("v-retry-cap", repoRoot).status).toBe("review");
    expect(getTask("v-retry-cap", repoRoot).retry_count).toBe(2);
    expect(getTask("v-retry-cap", repoRoot).last_failure).toBe("attempt");
  });

  it("resets retry state when validation passes", async () => {
    seedValidatingTask("v-pass-reset", "## Goal\nv.\n", repoRoot, manager);

    const failAgent = new FakeAgent({
      events: [
        { type: "text", text: "MARSHAL_GATE: fail once\n" },
        { type: "done", stopReason: "end_turn" },
      ],
    });

    await runOnce({ root: repoRoot, agent: failAgent, manager, validatorAgentId: "pi" });
    expect(getTask("v-pass-reset", repoRoot).retry_count).toBe(1);

    transitionTask("v-pass-reset", "validating", repoRoot);
    const passAgent = new FakeAgent({
      events: [
        { type: "text", text: "MARSHAL_GATE: pass\n" },
        { type: "done", stopReason: "end_turn" },
      ],
    });
    const result = await runOnce({
      root: repoRoot,
      agent: passAgent,
      manager,
      validatorAgentId: "pi",
    });

    expect(result?.status).toBe("validated");
    expect(getTask("v-pass-reset", repoRoot).status).toBe("review");
    expect(getTask("v-pass-reset", repoRoot).retry_count).toBe(0);
    expect(getTask("v-pass-reset", repoRoot).last_failure).toBeNull();
  });

  it("escalates to review immediately when maxRetries is 0", async () => {
    seedValidatingTask("v-zero-retries", "## Goal\nv.\n", repoRoot, manager);

    const failAgent = new FakeAgent({
      events: [
        { type: "text", text: "MARSHAL_GATE: fail no retries\n" },
        { type: "done", stopReason: "end_turn" },
      ],
    });

    const result = await runOnce({
      root: repoRoot,
      agent: failAgent,
      manager,
      validatorAgentId: "pi",
      maxRetries: 0,
    });

    expect(result?.status).toBe("validation_failed");
    expect(getTask("v-zero-retries", repoRoot).status).toBe("review");
    expect(getTask("v-zero-retries", repoRoot).retry_count).toBe(0);
    expect(getTask("v-zero-retries", repoRoot).last_failure).toBe("no retries");
  });
});

describe("runOnce event bus", () => {
  let repoRoot: string;
  let worktreeRoot: string;
  let manager: WorktreeManager;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "marshal-bus-"));
    worktreeRoot = mkdtempSync(join(tmpdir(), "marshal-bus-wt-"));
    initGitRepo(repoRoot);
    initMarshalState(repoRoot);
    initAgentConfig(repoRoot);
    manager = new WorktreeManager(repoRoot, { worktreeRoot });
  });

  afterEach(() => {
    delete process.env.MARSHAL_GLOBAL_CONFIG;
  });

  function createReadyFrozenTask(slug: string, specMarkdown: string) {
    createTask({ slug, title: `Task ${slug}`, specMarkdown }, repoRoot);
    transitionTask(slug, "ready", repoRoot);
    freezeTask(slug, repoRoot, manager);
  }

  it("publishes run.started/run.event/run.finished and task.transitioned on a build", async () => {
    const bus = new EventBus();
    const events: { type: string; payload: any }[] = [];
    bus.subscribe((e) => events.push({ type: e.type, payload: e.payload }));

    createReadyFrozenTask("bus-build", "## Goal\nBuild the feature.\n");

    const agent = new FakeAgent({
      events: [
        { type: "text", text: "working" },
        { type: "done", stopReason: "end_turn" },
      ],
      onSpawn: (session) => {
        mkdirSync(join(session.cwd, "src"), { recursive: true });
        writeFileSync(join(session.cwd, "src", "feature.ts"), "export const x = 1;\n");
      },
    });

    const result = await runOnce({ root: repoRoot, agent, manager, bus });

    expect(result?.status).toBe("built");

    const types = events.map((e) => e.type);
    expect(types).toContain(TaskTransitionedType);
    expect(types).toContain(RunStartedType);
    expect(types).toContain(RunEventType);
    expect(types).toContain(RunFinishedType);

    const transitions = events.filter((e) => e.type === TaskTransitionedType);
    expect(transitions[0].payload).toMatchObject({
      slug: "bus-build",
      from: "ready",
      to: "building",
    });
    expect(transitions[1].payload).toMatchObject({
      slug: "bus-build",
      from: "building",
      to: "validating",
    });

    const started = events.filter((e) => e.type === RunStartedType)[0];
    expect(started.payload.role).toBe("builder");

    const finished = events.filter((e) => e.type === RunFinishedType)[0];
    expect(finished.payload.status).toBe("done");
    expect(finished.payload.commitSha).toBe(result?.commitSha);
  });

  it("publishes daemon.idle then daemon.cycle_complete across runOnce cycles", async () => {
    const bus = new EventBus();
    const events: string[] = [];
    bus.subscribe((e) => events.push(e.type));

    const agent = new FakeAgent();
    const controller = new AbortController();
    const watchdog = setTimeout(() => controller.abort(), 100);

    try {
      await startDaemon({
        root: repoRoot,
        agent,
        manager,
        intervalMs: 10,
        signal: controller.signal,
        bus,
      });
    } finally {
      clearTimeout(watchdog);
    }

    expect(events).toContain(DaemonIdleType);
    expect(events).not.toContain(DaemonCycleCompleteType);
  });
});
