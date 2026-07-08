import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Agent, AgentEvent, AgentId, AgentSession, PromptOptions, SpawnOptions } from "../agent/types.js";
import { WorktreeManager } from "../worktree/manager.js";
import { createTask, getTask, transitionTask } from "../tasks/store.js";
import { freezeTask } from "../tasks/freeze.js";
import { RunLog } from "./run-log.js";
import { buildTask, renderBuilderPrompt, runOnce } from "./orchestrator.js";

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
    createTask(
      { slug: "not-frozen", title: "Not Frozen", specMarkdown: "## Goal\nx\n" },
      repoRoot,
    );
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
