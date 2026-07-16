import { execSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  Agent,
  AgentEvent,
  AgentId,
  AgentSession,
  PromptOptions,
  SpawnOptions,
} from "../src/agent/types.js";
import { WorktreeManager } from "../src/worktree/manager.js";
import { getTask, transitionTask } from "../src/tasks/store.js";
import { RunLog } from "../src/daemon/run-log.js";
import { runOnce } from "../src/daemon/orchestrator.js";

const binPath = resolve(process.cwd(), "bin/marshal");

function runCli(args: string[], cwd: string): { stdout: string; stderr: string } {
  const result = execFileSync("node", [binPath, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { stdout: result.toString(), stderr: "" };
}

function initGitRepo(root: string): void {
  execSync("git init -b main", { cwd: root, stdio: "ignore" });
  execSync("git config user.email test@example.com", { cwd: root, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: root, stdio: "ignore" });
  writeFileSync(join(root, "README.md"), "# Test\n");
  execSync("git add README.md", { cwd: root, stdio: "ignore" });
  execSync("git commit -m init", { cwd: root, stdio: "ignore" });
}

class StubAgent implements Agent {
  spawnCalls: { agentId: AgentId; opts: SpawnOptions }[] = [];
  private events: AgentEvent[];
  private onSpawn?: (session: AgentSession) => void;

  constructor(config: { events?: AgentEvent[]; onSpawn?: (session: AgentSession) => void } = {}) {
    this.events = config.events ?? [{ type: "done", stopReason: "end_turn" }];
    this.onSpawn = config.onSpawn;
  }

  async spawn(cwd: string, agentId: AgentId, opts: SpawnOptions = {}): Promise<AgentSession> {
    this.spawnCalls.push({ agentId, opts });
    const session: AgentSession = {
      agentId,
      cwd,
      name: opts.sessionName ?? `marshal-${agentId}`,
      recordId: "stub-rec",
    };
    this.onSpawn?.(session);
    return session;
  }

  async *prompt(
    _session: AgentSession,
    _text: string,
    _opts: PromptOptions = {},
  ): AsyncGenerator<AgentEvent> {
    for (const ev of this.events) {
      yield ev;
    }
  }

  async cancel(_session: AgentSession): Promise<void> {}

  async close(_session: AgentSession): Promise<void> {}
}

describe("M0 loop integration (CLI + orchestrator)", () => {
  let repoRoot: string;
  let worktreeRoot: string;
  let globalConfigPath: string;
  let manager: WorktreeManager;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "marshal-m0-"));
    worktreeRoot = mkdtempSync(join(tmpdir(), "marshal-m0-wt-"));
    initGitRepo(repoRoot);
    mkdirSync(join(repoRoot, ".marshal"), { recursive: true });

    globalConfigPath = join(worktreeRoot, "global-config.json");
    writeFileSync(
      globalConfigPath,
      JSON.stringify({
        agents: {
          builder: { id: "opencode", command: "opencode", args: ["acp"] },
          validator: { id: "pi", command: "pi-acp", args: [] },
        },
        worktree: { root: worktreeRoot },
      }),
    );
    process.env.MARSHAL_GLOBAL_CONFIG = globalConfigPath;

    manager = new WorktreeManager(repoRoot, { worktreeRoot });
  });

  afterEach(() => {
    delete process.env.MARSHAL_GLOBAL_CONFIG;
  });

  it("drives the full M0 loop: create -> ready -> build -> validate -> review", async () => {
    // 1. Initialize marshal state via the CLI.
    runCli(["init"], repoRoot);

    // 2. Create a task with a spec via the CLI.
    const specFile = join(repoRoot, "spec.md");
    writeFileSync(
      specFile,
      "## Goal\nAdd a feature module.\n\n## Acceptance Criteria\n- src/feature.ts exists.\n",
    );
    const createOut = runCli(
      ["task", "create", "--slug", "m0-smoke", "--title", "M0 smoke", "--spec-file", specFile],
      repoRoot,
    );
    expect(createOut.stdout).toContain("Created m0-smoke (backlog)");

    // 3. Freeze the spec at `task ready` via the CLI.
    const readyOut = runCli(["task", "ready", "m0-smoke"], repoRoot);
    expect(readyOut.stdout).toContain("m0-smoke -> ready");
    expect(readyOut.stdout).toContain("frozen: specs/0001-m0-smoke.md");

    // Verify the frozen spec is committed on the task branch.
    const branchRaw = execSync("git branch --list marshal/task/m0-smoke-*", {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    const branch = branchRaw.replace(/^[*+= ]+/m, "").trim();
    const lsTree = execSync("git ls-tree -r --name-only HEAD", {
      cwd: manager.create("m0-smoke").path,
      encoding: "utf8",
    });
    expect(lsTree).toContain("specs/0001-m0-smoke.md");

    // 4. `task show` reports ready.
    expect(runCli(["task", "show", "m0-smoke"], repoRoot).stdout).toContain("status: ready");

    // 5. Build cycle: runOnce claims the ready task, runs the builder stub, commits, -> validating.
    const builder = new StubAgent({
      events: [
        { type: "text", text: "Writing the feature.\n" },
        { type: "tool", title: "write file", status: "completed" },
        { type: "done", stopReason: "end_turn" },
      ],
      onSpawn: (session) => {
        mkdirSync(join(session.cwd, "src"), { recursive: true });
        writeFileSync(join(session.cwd, "src", "feature.ts"), "export const x = 1;\n");
      },
    });

    const buildResult = await runOnce({ root: repoRoot, agent: builder, manager });
    expect(buildResult).not.toBeNull();
    expect(buildResult?.status).toBe("built");
    expect(buildResult?.slug).toBe("m0-smoke");
    expect(buildResult?.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(getTask("m0-smoke", repoRoot).status).toBe("validating");
    expect(builder.spawnCalls).toHaveLength(1);
    expect(builder.spawnCalls[0].agentId).toBe("opencode");

    // The build commit is on the task branch.
    const worktree = manager.create("m0-smoke");
    expect(existsSync(join(worktree.path, "src", "feature.ts"))).toBe(true);
    const buildLogSubject = execSync("git log --format=%s -1", {
      cwd: worktree.path,
      encoding: "utf8",
    }).trim();
    expect(buildLogSubject).toBe("build: m0-smoke");

    // 6. Validate cycle: runOnce picks the validating task, runs the validator stub (gate pass), -> review.
    const validator = new StubAgent({
      events: [
        { type: "text", text: "Looks good.\nMARSHAL_GATE: pass\n" },
        { type: "done", stopReason: "end_turn" },
      ],
    });

    const validateResult = await runOnce({
      root: repoRoot,
      agent: validator,
      manager,
      validatorAgentId: "pi",
    });
    expect(validateResult).not.toBeNull();
    expect(validateResult?.status).toBe("validated");
    expect(validateResult?.slug).toBe("m0-smoke");
    expect(getTask("m0-smoke", repoRoot).status).toBe("review");
    expect(validator.spawnCalls).toHaveLength(1);
    expect(validator.spawnCalls[0].agentId).toBe("pi");

    // 7. `task show` via the CLI reports review.
    const showOut = runCli(["task", "show", "m0-smoke"], repoRoot).stdout;
    expect(showOut).toContain("status: review");

    // 8. Run log recorded both runs.
    const log = new RunLog(repoRoot);
    const task = getTask("m0-smoke", repoRoot);
    const buildRun = log.getRun(buildResult!.runId);
    expect(buildRun?.role).toBe("builder");
    expect(buildRun?.agentId).toBe("opencode");
    expect(buildRun?.status).toBe("done");
    expect(buildRun?.commitSha).toBe(buildResult?.commitSha);

    const validateRun = log.getRun(validateResult!.runId);
    expect(validateRun?.role).toBe("validator");
    expect(validateRun?.agentId).toBe("pi");
    expect(validateRun?.status).toBe("done");
    expect(validateRun?.commitSha).toBe(buildResult?.commitSha);

    // Both runs belong to the same task.
    expect(buildRun?.taskId).toBe(task.id);
    expect(validateRun?.taskId).toBe(task.id);
  }, 15000);

  it("routes a failing validation back to building, then to review on a second pass", async () => {
    runCli(["init"], repoRoot);

    const specFile = join(repoRoot, "spec.md");
    writeFileSync(specFile, "## Goal\nDo it right.\n");
    runCli(
      ["task", "create", "--slug", "m0-retry", "--title", "M0 retry", "--spec-file", specFile],
      repoRoot,
    );
    runCli(["task", "ready", "m0-retry"], repoRoot);

    const builder = new StubAgent({
      events: [{ type: "done", stopReason: "end_turn" }],
    });

    const failValidator = new StubAgent({
      events: [
        { type: "text", text: "MARSHAL_GATE: fail tests are red\n" },
        { type: "done", stopReason: "end_turn" },
      ],
    });

    const passValidator = new StubAgent({
      events: [
        { type: "text", text: "MARSHAL_GATE: pass\n" },
        { type: "done", stopReason: "end_turn" },
      ],
    });

    // Build cycle.
    await runOnce({ root: repoRoot, agent: builder, manager });
    expect(getTask("m0-retry", repoRoot).status).toBe("validating");

    // First validation fails -> bounces to building (retry 1).
    const first = await runOnce({
      root: repoRoot,
      agent: failValidator,
      manager,
      validatorAgentId: "pi",
    });
    expect(first?.status).toBe("validation_failed");
    expect(getTask("m0-retry", repoRoot).status).toBe("building");
    expect(getTask("m0-retry", repoRoot).retry_count).toBe(1);

    // Re-queue validation (building -> validating), then pass -> review, retry state cleared.
    transitionTask("m0-retry", "validating", repoRoot);
    const second = await runOnce({
      root: repoRoot,
      agent: passValidator,
      manager,
      validatorAgentId: "pi",
    });
    expect(second?.status).toBe("validated");
    expect(getTask("m0-retry", repoRoot).status).toBe("review");
    expect(getTask("m0-retry", repoRoot).retry_count).toBe(0);
    expect(getTask("m0-retry", repoRoot).last_failure).toBeNull();

    const showOut = runCli(["task", "show", "m0-retry"], repoRoot).stdout;
    expect(showOut).toContain("status: review");
  }, 15000);

  it("escalates to review after exhausting retries", async () => {
    runCli(["init"], repoRoot);

    const specFile = join(repoRoot, "spec.md");
    writeFileSync(specFile, "## Goal\nNever satisfied.\n");
    runCli(
      [
        "task",
        "create",
        "--slug",
        "m0-escalate",
        "--title",
        "M0 escalate",
        "--spec-file",
        specFile,
      ],
      repoRoot,
    );
    runCli(["task", "ready", "m0-escalate"], repoRoot);

    const builder = new StubAgent({
      events: [{ type: "done", stopReason: "end_turn" }],
    });
    const failValidator = new StubAgent({
      events: [
        { type: "text", text: "MARSHAL_GATE: fail nope\n" },
        { type: "done", stopReason: "end_turn" },
      ],
    });

    // Build once.
    await runOnce({ root: repoRoot, agent: builder, manager });
    expect(getTask("m0-escalate", repoRoot).status).toBe("validating");

    // Retry 1: fail -> building (retry_count=1).
    await runOnce({ root: repoRoot, agent: failValidator, manager, validatorAgentId: "pi" });
    expect(getTask("m0-escalate", repoRoot).status).toBe("building");
    expect(getTask("m0-escalate", repoRoot).retry_count).toBe(1);

    // Re-queue, retry 2: fail -> building (retry_count=2).
    transitionTask("m0-escalate", "validating", repoRoot);
    await runOnce({ root: repoRoot, agent: failValidator, manager, validatorAgentId: "pi" });
    expect(getTask("m0-escalate", repoRoot).status).toBe("building");
    expect(getTask("m0-escalate", repoRoot).retry_count).toBe(2);

    // Re-queue, retry 3: cap reached (2 < 2 is false) -> review with failure summary.
    transitionTask("m0-escalate", "validating", repoRoot);
    await runOnce({ root: repoRoot, agent: failValidator, manager, validatorAgentId: "pi" });

    expect(getTask("m0-escalate", repoRoot).status).toBe("review");
    expect(getTask("m0-escalate", repoRoot).retry_count).toBe(2);
    expect(getTask("m0-escalate", repoRoot).last_failure).toBe("nope");

    const showOut = runCli(["task", "show", "m0-escalate"], repoRoot).stdout;
    expect(showOut).toContain("status: review");
    expect(showOut).toContain("last failure: nope");
  }, 15000);
});
