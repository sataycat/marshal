import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorktreeManager } from "../worktree/manager.js";
import { createTask, getTask, transitionTask } from "./store.js";
import { freezeTask, FreezeError, specRelPathFor } from "./freeze.js";

function initGitRepo(root: string): void {
  execSync("git init -b main", { cwd: root, stdio: "ignore" });
  execSync("git config user.email test@example.com", { cwd: root, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: root, stdio: "ignore" });
  writeFileSync(join(root, "README.md"), "# Test\n");
  execSync("git add README.md", { cwd: root, stdio: "ignore" });
  execSync("git commit -m init", { cwd: root, stdio: "ignore" });
}

function gitRevList(path: string, ref: string = "HEAD"): string {
  return execSync(`git rev-parse ${ref}`, { cwd: path, encoding: "utf8" }).trim();
}

function gitLogBody(path: string, file: string): string {
  return execSync(`git log --format=%B -1 -- ${file}`, { cwd: path, encoding: "utf8" }).trim();
}

describe("freezeTask", () => {
  let repoRoot: string;
  let manager: WorktreeManager;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "marshal-repo-"));
    initGitRepo(repoRoot);
    manager = new WorktreeManager("test-repository", repoRoot);
  });

  afterEach(() => {
    delete process.env.MARSHAL_GLOBAL_CONFIG;
  });

  it("writes specs/<NNNN>-<slug>.md and commits with `freeze: <slug>`", () => {
    const task = createTask(
      {
        slug: "add-login",
        title: "Add login page",
        specMarkdown: "## Goal\nLet users log in.\n",
      },
      repoRoot,
    );
    transitionTask(task.slug, "ready", repoRoot);

    const result = freezeTask(task.slug, repoRoot, manager);

    expect(result.slug).toBe("add-login");
    expect(result.branch).toMatch(/^marshal\/task\/add-login-/);
    expect(existsSync(result.specPath)).toBe(true);

    const rel = specRelPathFor(task.slug, task.id);
    expect(result.specRelPath).toBe(rel);

    const written = readFileSync(result.specPath, "utf8");
    expect(written).toContain("slug: add-login");
    expect(written).toContain("## Goal");
    expect(written.trimEnd()).toMatch(/^---$/m);

    expect(gitLogBody(result.worktreePath, rel)).toBe("freeze: add-login");

    const branchSha = execSync(`git rev-parse ${result.branch}`, {
      cwd: result.worktreePath,
      encoding: "utf8",
    }).trim();
    expect(result.commitSha).toBe(branchSha);
  });

  it("refuses to freeze a task not in ready state", () => {
    const task = createTask(
      { slug: "add-logout", title: "Add logout", specMarkdown: "x" },
      repoRoot,
    );
    expect(() => freezeTask(task.slug, repoRoot, manager)).toThrow(FreezeError);
    expect(() => freezeTask(task.slug, repoRoot, manager)).toThrow(/must be 'ready'/);
  });

  it("refuses to freeze a ready task with an empty spec", () => {
    const task = createTask({ slug: "empty-spec", title: "Empty" }, repoRoot);
    transitionTask(task.slug, "ready", repoRoot);
    expect(() => freezeTask(task.slug, repoRoot, manager)).toThrow(/spec is empty/);
  });

  it("throws TaskNotFoundError-equivalent FreezeError for unknown slug", () => {
    expect(() => freezeTask("does-not-exist", repoRoot, manager)).toThrow(/task not found/);
  });

  it("zero-pads the task id to four digits in the spec filename", () => {
    const task = createTask(
      { slug: "pad-test", title: "Pad", specMarkdown: "body" },
      repoRoot,
    );
    transitionTask(task.slug, "ready", repoRoot);
    const result = freezeTask(task.slug, repoRoot, manager);
    expect(result.specRelPath).toBe(`specs/${String(task.id).padStart(4, "0")}-pad-test.md`);
  });

  it("reuses the existing worktree+branch on a second freeze (idempotent re-run)", () => {
    const task = createTask(
      { slug: "idempotent", title: "Idem", specMarkdown: "first body" },
      repoRoot,
    );
    transitionTask(task.slug, "ready", repoRoot);

    const first = freezeTask(task.slug, repoRoot, manager);
    const second = freezeTask(task.slug, repoRoot, manager);

    expect(second.worktreePath).toBe(first.worktreePath);
    expect(second.branch).toBe(first.branch);
    expect(readFileSync(second.specPath, "utf8")).toContain("first body");
  });

  it("the created task branch contains the frozen spec file", () => {
    const task = createTask(
      { slug: "branch-check", title: "Check", specMarkdown: "on branch" },
      repoRoot,
    );
    transitionTask(task.slug, "ready", repoRoot);
    const result = freezeTask(task.slug, repoRoot, manager);

    const lsTree = execSync(`git ls-tree -r --name-only ${result.branch}`, {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(lsTree).toContain(result.specRelPath);
  });
});
