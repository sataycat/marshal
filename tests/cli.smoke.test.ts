import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerRepository, removeRepository, selectRepository } from "../src/repositories/store.js";

const binPath = resolve(process.cwd(), "bin/marshal");

function run(args: string[], cwd?: string): { stdout: string; stderr: string } {
  const result = execFileSync("node", [binPath, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { stdout: result.toString(), stderr: "" };
}

describe("CLI smoke tests", () => {
  let globalConfigPath: string;
  let originalHome: string | undefined;
  let selectedRepositoryId: string | undefined;

  function selectTestRepository(root: string): void {
    const machineDir = join(process.env.HOME!, ".marshal");
    const repository = registerRepository(root, machineDir);
    selectRepository(repository.id, machineDir);
    selectedRepositoryId = repository.id;
  }

  beforeEach(() => {
    // `marshal init` is non-interactive (ADR-024 Decision 3): it checks
    // prerequisites, writes structured direct ACP defaults, and
    // initializes repo state. Tests exercise the already-configured fast
    // path (ADR-020 Decision 1): a complete ~/.marshal/config.json
    // collapses phases 1–5.
    originalHome = process.env.HOME;
    process.env.HOME = mkdtempSync(join(tmpdir(), "marshal-home-"));
    const globalDir = mkdtempSync(join(tmpdir(), "marshal-global-"));
    globalConfigPath = join(globalDir, "config.json");
    writeFileSync(
      globalConfigPath,
      JSON.stringify({
        agents: {
          builder: { id: "opencode", command: "opencode", args: ["acp"] },
          validator: { id: "pi", command: "pi-acp", args: [] },
        },
      }),
    );
    process.env.MARSHAL_GLOBAL_CONFIG = globalConfigPath;
  });

  afterEach(() => {
    if (selectedRepositoryId) {
      removeRepository(selectedRepositoryId, join(process.env.HOME!, ".marshal"));
      selectedRepositoryId = undefined;
    }
    delete process.env.MARSHAL_GLOBAL_CONFIG;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it("prints version with --version", () => {
    const { stdout } = run(["--version"]);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("initializes repo state with init", () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-"));
    const { stdout } = run(["init"], root);
    expect(stdout).toContain("machine already configured");
    expect(stdout).toContain("repo initialized");
    expect(existsSync(join(root, ".marshal"))).toBe(true);
    expect(existsSync(join(root, ".marshal", "state.db"))).toBe(true);
  });

  it("lists no tasks with task list", () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-"));
    run(["init"], root);
    selectTestRepository(root);
    const { stdout } = run(["task", "list"], root);
    expect(stdout.trim()).toBe("No tasks.");
  });

  it("creates and destroys a worktree for a task", () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-"));
    const worktreeRoot = mkdtempSync(join(tmpdir(), "marshal-wt-"));

    execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: root,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root, stdio: "ignore" });
    execFileSync("node", ["-e", "require('fs').writeFileSync('README.md','# test\\n')"], {
      cwd: root,
      stdio: "ignore",
    });
    execFileSync("git", ["add", "README.md"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: root, stdio: "ignore" });

    run(["init"], root);
    selectTestRepository(root);

    const worktreeConfigPath = join(worktreeRoot, "global-config.json");
    writeFileSync(worktreeConfigPath, JSON.stringify({ worktree: { root: worktreeRoot } }));
    process.env.MARSHAL_GLOBAL_CONFIG = worktreeConfigPath;

    try {
      const createResult = run(["worktree", "create", "--task", "hello-world"], root);
      const worktreePath = createResult.stdout.trim();
      expect(existsSync(worktreePath)).toBe(true);
      expect(existsSync(join(worktreePath, "README.md"))).toBe(true);

      const branches = execFileSync("git", ["branch"], { cwd: root, encoding: "utf8" });
      expect(branches).toContain("marshal/task/hello-world-");

      run(["worktree", "destroy", "--task", "hello-world"], root);
      expect(existsSync(worktreePath)).toBe(false);
    } finally {
      delete process.env.MARSHAL_GLOBAL_CONFIG;
    }
  });

  it("freezes a task spec at `task ready`", () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-"));
    const worktreeRoot = mkdtempSync(join(tmpdir(), "marshal-wt-"));

    execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: root,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init", "--allow-empty"], {
      cwd: root,
      stdio: "ignore",
    });

    run(["init"], root);
    selectTestRepository(root);

    const worktreeConfigPath = join(worktreeRoot, "global-config.json");
    writeFileSync(worktreeConfigPath, JSON.stringify({ worktree: { root: worktreeRoot } }));
    process.env.MARSHAL_GLOBAL_CONFIG = worktreeConfigPath;

    try {
      const specFile = join(root, "spec.md");
      writeFileSync(specFile, "## Goal\nBuild the thing.\n");
      run(
        [
          "task",
          "create",
          "--slug",
          "frozen-thing",
          "--title",
          "Frozen thing",
          "--spec-file",
          specFile,
        ],
        root,
      );
      run(["task", "ready", "frozen-thing"], root);

      const showOut = run(["task", "show", "frozen-thing"], root).stdout;
      expect(showOut).toContain("status: ready");

      const worktrees = execFileSync("git", ["worktree", "list"], {
        cwd: root,
        encoding: "utf8",
      });
      expect(worktrees).toContain("frozen-thing-");

      const branchRaw = execFileSync("git", ["branch", "--list", "marshal/task/frozen-thing-*"], {
        cwd: root,
        encoding: "utf8",
      }).trim();
      const branch = branchRaw.replace(/^[*+= ]+/m, "").trim();
      expect(branch).toMatch(/^marshal\/task\/frozen-thing-/);
      const lsTree = execFileSync("git", ["ls-tree", "-r", "--name-only", branch], {
        cwd: root,
        encoding: "utf8",
      });
      expect(lsTree).toContain("specs/0001-frozen-thing.md");

      const logBody = execFileSync(
        "git",
        ["log", "--format=%B", "-1", branch, "--", "specs/0001-frozen-thing.md"],
        { cwd: root, encoding: "utf8" },
      ).trim();
      expect(logBody).toBe("freeze: frozen-thing");
    } finally {
      delete process.env.MARSHAL_GLOBAL_CONFIG;
    }
  });

  it("supports escape-hatch transitions via `task transition`", () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-"));
    run(["init"], root);
    selectTestRepository(root);
    run(["task", "create", "--slug", "stuck", "--title", "Stuck"], root);

    run(["task", "transition", "stuck", "ready"], root);
    run(["task", "transition", "stuck", "building"], root);

    run(["task", "transition", "stuck", "ready"], root);
    expect(run(["task", "show", "stuck"], root).stdout).toContain("status: ready");

    run(["task", "transition", "stuck", "building"], root);
    run(["task", "transition", "stuck", "backlog"], root);
    expect(run(["task", "show", "stuck"], root).stdout).toContain("status: backlog");
  }, 15000);

  it("supports validating -> backlog escape hatch", () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-"));
    run(["init"], root);
    selectTestRepository(root);
    run(["task", "create", "--slug", "vstuck", "--title", "V Stuck"], root);
    run(["task", "transition", "vstuck", "ready"], root);
    run(["task", "transition", "vstuck", "building"], root);
    run(["task", "transition", "vstuck", "validating"], root);
    run(["task", "transition", "vstuck", "backlog"], root);
    expect(run(["task", "show", "vstuck"], root).stdout).toContain("status: backlog");
  });

  it("shows the last run's error context in `task show` when stuck in building", () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-"));
    run(["init"], root);
    selectTestRepository(root);
    run(["task", "create", "--slug", "bricked", "--title", "Bricked"], root);
    run(["task", "transition", "bricked", "ready"], root);
    run(["task", "transition", "bricked", "building"], root);

    const dbPath = join(root, ".marshal", "state.db");
    const db = new Database(dbPath);
    const taskId = db.prepare("SELECT id FROM tasks WHERE slug = ?").get("bricked") as {
      id: number;
    };
    db.prepare(
      "INSERT INTO runs (task_id, role, agent_id, status, error) VALUES (?, 'builder', 'opencode', 'error', ?)",
    ).run(taskId.id, "spawn failed: acpx missing");
    db.close();

    const showOut = run(["task", "show", "bricked"], root).stdout;
    expect(showOut).toContain("status: building");
    expect(showOut).toContain("last run: #");
    expect(showOut).toContain("builder opencode error");
    expect(showOut).toContain("run error: spawn failed: acpx missing");
  });

  it("exposes `start` with server options", () => {
    const { stdout } = run(["start", "--help"]);
    expect(stdout).toContain("Poll interval");
    expect(stdout).toContain("--lan");
    expect(stdout).toContain("--password");
  });

  it("prints actionable LAN password guidance without a stack trace", () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-"));
    run(["init"], root);

    const result = spawnSync("node", [binPath, "start", "--lan"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, MARSHAL_UI_PASSWORD: "" },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("LAN access requires a UI password.");
    expect(result.stderr).toContain("marshal start --lan --password <password>");
    expect(result.stderr).not.toContain("at startHttpServer");
  });
});
