import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

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
  it("prints version with --version", () => {
    const { stdout } = run(["--version"]);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("initializes repo state with init", () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-"));
    const { stdout } = run(["init"], root);
    expect(stdout).toContain("Marshal initialized");
    expect(existsSync(join(root, ".marshal"))).toBe(true);
    expect(existsSync(join(root, ".marshal", "state.db"))).toBe(true);
  });

  it("lists no tasks with task list", () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-"));
    run(["init"], root);
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

    const globalConfigPath = join(worktreeRoot, "global-config.json");
    writeFileSync(globalConfigPath, JSON.stringify({ worktree: { root: worktreeRoot } }));
    process.env.MARSHAL_GLOBAL_CONFIG = globalConfigPath;

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

    const globalConfigPath = join(worktreeRoot, "global-config.json");
    writeFileSync(globalConfigPath, JSON.stringify({ worktree: { root: worktreeRoot } }));
    process.env.MARSHAL_GLOBAL_CONFIG = globalConfigPath;

    try {
      const specFile = join(root, "spec.md");
      writeFileSync(specFile, "## Goal\nBuild the thing.\n");
      run(
        ["task", "create", "--slug", "frozen-thing", "--title", "Frozen thing", "--spec-file", specFile],
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
});
