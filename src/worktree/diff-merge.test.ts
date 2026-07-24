import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorktreeManager } from "./manager.js";
import { parseDiffStats } from "./diff-merge.js";

function initGitRepo(root: string): void {
  execSync("git init -b main", { cwd: root, stdio: "ignore" });
  execSync("git config user.email test@example.com", { cwd: root, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: root, stdio: "ignore" });
  execSync("git config core.fsmonitor false", { cwd: root, stdio: "ignore" });
  writeFileSync(join(root, "README.md"), "# Test\n");
  execSync("git add README.md", { cwd: root, stdio: "ignore" });
  execSync("git commit -m init", { cwd: root, stdio: "ignore" });
}

describe("parseDiffStats", () => {
  it("counts files, insertions, and deletions from a unified diff", () => {
    const diff = [
      "diff --git a/foo.txt b/foo.txt",
      "index 1111111..2222222 100644",
      "--- a/foo.txt",
      "+++ b/foo.txt",
      "@@ -1,2 +1,3 @@",
      " context",
      "-old line",
      "+new line",
      "+another new",
      "diff --git a/bar.txt b/bar.txt",
      "--- a/bar.txt",
      "+++ b/bar.txt",
      "@@ -1 +1 @@",
      "-gone",
      "+here",
    ].join("\n");
    expect(parseDiffStats(diff)).toEqual({ files: 2, insertions: 3, deletions: 2 });
  });

  it("handles an empty diff", () => {
    expect(parseDiffStats("")).toEqual({ files: 0, insertions: 0, deletions: 0 });
  });

  it("ignores +++ / --- header lines", () => {
    const diff = ["diff --git a/a b/a", "--- a/a", "+++ b/a", "@@ -0,0 +1 @@", "+added"].join("\n");
    expect(parseDiffStats(diff)).toEqual({ files: 1, insertions: 1, deletions: 0 });
  });
});

describe("WorktreeManager diff & merge", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "marshal-diff-repo-"));
    initGitRepo(repoRoot);
  });

  afterEach(() => {
    delete process.env.MARSHAL_GLOBAL_CONFIG;
  });

  function commitIn(path: string, file: string, content: string, msg: string): void {
    writeFileSync(join(path, file), content);
    execSync(`git add ${file}`, { cwd: path, stdio: "ignore" });
    execSync(`git commit -m ${JSON.stringify(msg)}`, { cwd: path, stdio: "ignore" });
  }

  it("returns the branch diff and stats for a task with a worktree", () => {
    const manager = new WorktreeManager("test-repository", repoRoot);
    const info = manager.create("diff-task");
    commitIn(info.path, "feature.txt", "new feature\n", "feature");

    const result = manager.diffForSlug("diff-task");
    expect(result.diff).toContain("diff --git");
    expect(result.diff).toContain("+new feature");
    expect(result.stats.files).toBe(1);
    expect(result.stats.insertions).toBeGreaterThanOrEqual(1);
    expect(result.stats.deletions).toBe(0);
  });

  it("throws DiffError when there is no worktree for the slug", () => {
    const manager = new WorktreeManager("test-repository", repoRoot);
    expect(() => manager.diffForSlug("missing")).toThrow(/Cannot diff task missing/);
  });

  it("merges the task branch into the source base branch and returns the new HEAD", () => {
    const manager = new WorktreeManager("test-repository", repoRoot);
    const info = manager.create("merge-task");
    commitIn(info.path, "feature.txt", "merged feature\n", "feature");

    const baseBefore = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
    const result = manager.mergeTaskBranch("merge-task");
    const baseAfter = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
    expect(result.commitSha).toBe(baseAfter);
    expect(baseAfter).not.toBe(baseBefore);
    expect(execSync("git log --oneline", { cwd: repoRoot, encoding: "utf8" })).toContain("merge:");
  });

  it("refuses to merge when the source checkout has tracked modifications", () => {
    const manager = new WorktreeManager("test-repository", repoRoot);
    const info = manager.create("dirty-merge");
    commitIn(info.path, "x.txt", "x\n", "x");
    writeFileSync(join(repoRoot, "README.md"), "# Modified\n");
    expect(() => manager.mergeTaskBranch("dirty-merge")).toThrow(/uncommitted changes/);
  });

  it("throws MergeError when there is no worktree for the slug", () => {
    const manager = new WorktreeManager("test-repository", repoRoot);
    expect(() => manager.mergeTaskBranch("missing")).toThrow(/Cannot merge task missing/);
  });
});
