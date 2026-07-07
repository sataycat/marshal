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
});
