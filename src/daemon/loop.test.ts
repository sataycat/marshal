import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
import { formatRunOnceResult, startDaemon } from "./loop.js";
import type { RunOnceResult } from "./orchestrator.js";

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
        builder: { id: "codex", command: "codex-acp", args: [] },
        validator: { id: "claude", command: "claude-agent-acp", args: [] },
        specAuthor: { id: "opencode", command: "opencode", args: ["acp"] },
      },
    }),
  );
  process.env.MARSHAL_GLOBAL_CONFIG = cfgPath;
}

class FakeAgent implements Agent {
  spawnCalls: { cwd: string; agentId: AgentId; opts: SpawnOptions }[] = [];
  closeCalls: AgentSession[] = [];
  private events: AgentEvent[];
  private onSpawn?: (session: AgentSession) => void;
  private spawnThrows?: Error;

  constructor(
    config: {
      events?: AgentEvent[];
      onSpawn?: (session: AgentSession) => void;
      spawnThrows?: Error;
    } = {},
  ) {
    this.events = config.events ?? [{ type: "done", stopReason: "end_turn" }];
    this.onSpawn = config.onSpawn;
    this.spawnThrows = config.spawnThrows;
  }

  async spawn(cwd: string, agentId: AgentId, opts: SpawnOptions = {}): Promise<AgentSession> {
    this.spawnCalls.push({ cwd, agentId, opts });
    if (this.spawnThrows) throw this.spawnThrows;
    const session: AgentSession = {
      agentId,
      cwd,
      name: opts.sessionName ?? `marshal-${agentId}`,
      recordId: "fake-rec",
    };
    this.onSpawn?.(session);
    return session;
  }

  async *prompt(
    session: AgentSession,
    _text: string,
    _opts: PromptOptions = {},
  ): AsyncGenerator<AgentEvent> {
    for (const ev of this.events) {
      yield ev;
    }
  }

  async cancel(_session: AgentSession): Promise<void> {}

  async close(session: AgentSession): Promise<void> {
    this.closeCalls.push(session);
  }
}

describe("formatRunOnceResult", () => {
  it("returns 'no ready task' for null", () => {
    expect(formatRunOnceResult(null)).toBe("no ready task");
  });

  it("formats a built result with slug, status, and short sha", () => {
    const result: RunOnceResult = {
      slug: "add-thing",
      runId: 3,
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      status: "built",
    };
    expect(formatRunOnceResult(result)).toBe("add-thing built 0123456789ab");
  });

  it("formats an error result with the error message", () => {
    const result: RunOnceResult = {
      slug: "boom",
      runId: 1,
      commitSha: "",
      status: "error",
      error: "spawn failed: acpx missing",
    };
    expect(formatRunOnceResult(result)).toBe("boom error error: spawn failed: acpx missing");
  });

  it("formats a validation_failed result with the reason", () => {
    const result: RunOnceResult = {
      slug: "gate",
      runId: 2,
      commitSha: "abc123",
      status: "validation_failed",
      reason: "tests are red",
    };
    expect(formatRunOnceResult(result)).toBe("gate validation_failed abc123 reason: tests are red");
  });

  it("formats a skipped result with the error message", () => {
    const result: RunOnceResult = {
      slug: "skip",
      runId: 0,
      commitSha: "",
      status: "skipped",
      error: "frozen spec missing: specs/0001-skip.md",
    };
    expect(formatRunOnceResult(result)).toBe(
      "skip skipped error: frozen spec missing: specs/0001-skip.md",
    );
  });
});

describe("startDaemon", () => {
  let repoRoot: string;
  let manager: WorktreeManager;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "marshal-daemon-"));
    initGitRepo(repoRoot);
    initMarshalState(repoRoot);
    initAgentConfig(repoRoot);
    manager = new WorktreeManager("test-repository", repoRoot);
  });

  afterEach(() => {
    delete process.env.MARSHAL_GLOBAL_CONFIG;
  });

  function createReadyFrozenTask(slug: string, specMarkdown: string) {
    createTask({ slug, title: `Task ${slug}`, specMarkdown }, repoRoot);
    transitionTask(slug, "ready", repoRoot);
    freezeTask(slug, repoRoot, manager);
  }

  it("exits immediately when the signal is already aborted", async () => {
    const agent = new FakeAgent();
    const controller = new AbortController();
    controller.abort();

    await startDaemon({
      root: repoRoot,
      agent,
      manager,
      intervalMs: 10,
      signal: controller.signal,
    });

    expect(agent.spawnCalls).toHaveLength(0);
  });

  it("runs the full build + validate loop across cycles until aborted", async () => {
    createReadyFrozenTask("daemon-e2e", "## Goal\nBuild the feature.\n");

    const agent = new FakeAgent({
      events: [
        { type: "text", text: "MARSHAL_GATE: pass\n" },
        { type: "done", stopReason: "end_turn" },
      ],
      onSpawn: (session) => {
        mkdirSync(join(session.cwd, "src"), { recursive: true });
        writeFileSync(join(session.cwd, "src", "feature.ts"), "export const x = 1;\n");
      },
    });

    const controller = new AbortController();
    const watchdog = setTimeout(() => controller.abort(), 5000);
    const poll = setInterval(() => {
      if (getTask("daemon-e2e", repoRoot).status === "review") {
        controller.abort();
      }
    }, 10);

    try {
      await startDaemon({
        root: repoRoot,
        agent,
        manager,
        intervalMs: 10,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(watchdog);
      clearInterval(poll);
    }

    expect(getTask("daemon-e2e", repoRoot).status).toBe("review");
    expect(agent.spawnCalls.length).toBeGreaterThanOrEqual(2);
    // ADR-023 Decision 2: builder/validator ids come from the config, not constants.
    expect(agent.spawnCalls[0].agentId).toBe("codex");
    expect(agent.spawnCalls[1].agentId).toBe("claude");
  }, 10000);

  it("idles without spawning when no task is ready", async () => {
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
      });
    } finally {
      clearTimeout(watchdog);
    }

    expect(agent.spawnCalls).toHaveLength(0);
  }, 5000);
});
