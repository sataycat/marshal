import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runCli, spawnCli, useCliTestEnvironment } from "./cli-test-helpers.js";

describe("CLI smoke tests", () => {
  const { selectTestRepository } = useCliTestEnvironment();

  it("prints version with --version", () => {
    const { stdout } = runCli(["--version"]);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("initializes repo state with init", () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-"));
    const { stdout } = runCli(["init"], root);
    expect(stdout).toContain("machine already configured");
    expect(stdout).toContain("daemon database initialized");
    expect(existsSync(join(root, ".marshal"))).toBe(false);
  });

  it("lists no tasks with task list", () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-"));
    runCli(["init"], root);
    selectTestRepository(root);
    const { stdout } = runCli(["task", "list"], root);
    expect(stdout.trim()).toBe("No tasks.");
  });

  it("creates and destroys a worktree for a task", () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-"));
    const worktreeRoot = mkdtempSync(join(tmpdir(), "marshal-wt-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, "README.md"), "# test\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync(
      "git",
      ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "init"],
      { cwd: root, stdio: "ignore" },
    );
    runCli(["init"], root);
    selectTestRepository(root);
    const worktreeConfigPath = join(worktreeRoot, "global-config.json");
    writeFileSync(worktreeConfigPath, JSON.stringify({ worktree: { root: worktreeRoot } }));
    process.env.MARSHAL_GLOBAL_CONFIG = worktreeConfigPath;

    const createResult = runCli(["worktree", "create", "--task", "hello-world"], root);
    const worktreePath = createResult.stdout.trim();
    expect(existsSync(worktreePath)).toBe(true);
    expect(existsSync(join(worktreePath, "README.md"))).toBe(true);
    expect(execFileSync("git", ["branch"], { cwd: root, encoding: "utf8" })).toContain(
      "marshal/task/hello-world-",
    );
    runCli(["worktree", "destroy", "--task", "hello-world"], root);
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("freezes a task spec at `task ready`", () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-"));
    const worktreeRoot = mkdtempSync(join(tmpdir(), "marshal-wt-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
    execFileSync(
      "git",
      [
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=Test",
        "commit",
        "-m",
        "init",
        "--allow-empty",
      ],
      { cwd: root, stdio: "ignore" },
    );
    runCli(["init"], root);
    selectTestRepository(root);
    const worktreeConfigPath = join(worktreeRoot, "global-config.json");
    writeFileSync(worktreeConfigPath, JSON.stringify({ worktree: { root: worktreeRoot } }));
    process.env.MARSHAL_GLOBAL_CONFIG = worktreeConfigPath;
    const specFile = join(root, "spec.md");
    writeFileSync(specFile, "## Goal\nBuild the thing.\n");

    runCli(
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
    runCli(["task", "ready", "frozen-thing"], root);
    expect(runCli(["task", "show", "frozen-thing"], root).stdout).toContain("status: ready");
    const branch = execFileSync("git", ["branch", "--list", "marshal/task/frozen-thing-*"], {
      cwd: root,
      encoding: "utf8",
    })
      .trim()
      .replace(/^[*+= ]+/m, "")
      .trim();
    expect(branch).toMatch(/^marshal\/task\/frozen-thing-/);
    expect(
      execFileSync("git", ["ls-tree", "-r", "--name-only", branch], {
        cwd: root,
        encoding: "utf8",
      }),
    ).toContain("specs/0001-frozen-thing.md");
    expect(
      execFileSync(
        "git",
        ["log", "--format=%B", "-1", branch, "--", "specs/0001-frozen-thing.md"],
        { cwd: root, encoding: "utf8" },
      ).trim(),
    ).toBe("freeze: frozen-thing");
  });

  it("supports escape-hatch transitions via `task transition`", () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-"));
    runCli(["init"], root);
    selectTestRepository(root);
    runCli(["task", "create", "--slug", "stuck", "--title", "Stuck"], root);
    runCli(["task", "transition", "stuck", "ready"], root);
    runCli(["task", "transition", "stuck", "building"], root);
    runCli(["task", "transition", "stuck", "ready"], root);
    expect(runCli(["task", "show", "stuck"], root).stdout).toContain("status: ready");
    runCli(["task", "transition", "stuck", "building"], root);
    runCli(["task", "transition", "stuck", "backlog"], root);
    expect(runCli(["task", "show", "stuck"], root).stdout).toContain("status: backlog");
  });

  it("supports validating -> backlog escape hatch", () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-"));
    runCli(["init"], root);
    selectTestRepository(root);
    runCli(["task", "create", "--slug", "vstuck", "--title", "V Stuck"], root);
    runCli(["task", "transition", "vstuck", "ready"], root);
    runCli(["task", "transition", "vstuck", "building"], root);
    runCli(["task", "transition", "vstuck", "validating"], root);
    runCli(["task", "transition", "vstuck", "backlog"], root);
    expect(runCli(["task", "show", "vstuck"], root).stdout).toContain("status: backlog");
  });

  it("shows the last run's error context in `task show` when stuck in building", () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-"));
    runCli(["init"], root);
    selectTestRepository(root);
    runCli(["task", "create", "--slug", "bricked", "--title", "Bricked"], root);
    runCli(["task", "transition", "bricked", "ready"], root);
    runCli(["task", "transition", "bricked", "building"], root);
    const db = new Database(join(process.env.MARSHAL_HOME!, "marshal.db"));
    const task = db.prepare("SELECT id FROM tasks WHERE slug = ?").get("bricked") as { id: number };
    const repository = db.prepare("SELECT repository_id FROM tasks WHERE id = ?").get(task.id) as { repository_id: string };
    db.prepare(
      "INSERT INTO runs (repository_id, task_id, role, agent_id, status, error) VALUES (?, ?, 'builder', 'opencode', 'error', ?)",
    ).run(repository.repository_id, task.id, "spawn failed: acpx missing");
    db.close();

    const showOut = runCli(["task", "show", "bricked"], root).stdout;
    expect(showOut).toContain("status: building");
    expect(showOut).toContain("last run: #");
    expect(showOut).toContain("builder opencode error");
    expect(showOut).toContain("run error: spawn failed: acpx missing");
  });

  it("exposes `start` with server options", () => {
    const { stdout } = runCli(["start", "--help"]);
    expect(stdout).toContain("Poll interval");
    expect(stdout).toContain("--lan");
    expect(stdout).toContain("--password");
  });

  it("prints actionable LAN password guidance without a stack trace", () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-"));
    runCli(["init"], root);

    const result = spawnCli(["start", "--lan"], root, {
      ...process.env,
      MARSHAL_UI_PASSWORD: "",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("LAN access requires a UI password.");
    expect(result.stderr).toContain("marshal start --lan --password <password>");
    expect(result.stderr).not.toContain("at startHttpServer");
  });
});
