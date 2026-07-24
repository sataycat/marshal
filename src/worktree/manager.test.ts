import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorktreeManager } from "./manager.js";
import { openDb } from "../db/index.js";
import { ensureRepositoryNamespace } from "../storage/layout.js";

function initGitRepo(root: string): void {
  execSync("git init -b main", { cwd: root, stdio: "ignore" });
  execSync("git config user.email test@example.com", { cwd: root, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: root, stdio: "ignore" });
  writeFileSync(join(root, "README.md"), "# Test\n");
  execSync("git add README.md", { cwd: root, stdio: "ignore" });
  execSync("git commit -m init", { cwd: root, stdio: "ignore" });
}

describe("WorktreeManager", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "marshal-repo-"));
    initGitRepo(repoRoot);
  });

  afterEach(() => {
    delete process.env.MARSHAL_GLOBAL_CONFIG;
  });

  it("creates a worktree and branch for a task", async () => {
    const manager = new WorktreeManager("test-repository", repoRoot);
    const info = manager.create("hello-world");

    expect(info.slug).toBe("hello-world");
    expect(info.branch).toMatch(/^marshal\/task\/hello-world-/);
    expect(existsSync(info.path)).toBe(true);
    expect(existsSync(join(info.path, "README.md"))).toBe(true);
  });

  it("destroys a worktree and branch", async () => {
    const manager = new WorktreeManager("test-repository", repoRoot);
    const info = manager.create("hello-world");

    manager.destroy("hello-world");

    expect(existsSync(info.path)).toBe(false);
    const branches = execSync("git branch", { cwd: repoRoot, encoding: "utf8" });
    expect(branches).not.toContain(info.branch);
  });

  it("throws when creating a worktree outside a git repo", () => {
    const notARepo = mkdtempSync(join(tmpdir(), "not-a-repo-"));
    expect(() => new WorktreeManager("test-repository", notARepo)).toThrow("not a git repository");
  });

  it("throws when destroying a non-existent worktree", () => {
    const manager = new WorktreeManager("test-repository", repoRoot);
    expect(() => manager.destroy("does-not-exist")).toThrow("No worktree found");
  });

  it("reuses an existing worktree for the same slug", async () => {
    const manager = new WorktreeManager("test-repository", repoRoot);
    const first = manager.create("hello-world");
    const second = manager.create("hello-world");

    expect(second.path).toBe(first.path);
    expect(second.branch).toBe(first.branch);
  });

  it("copies allowed gitignored files via .worktreeinclude", async () => {
    writeFileSync(join(repoRoot, ".gitignore"), ".env.local\n");
    writeFileSync(join(repoRoot, ".env.local"), "SECRET=hello\n");
    writeFileSync(join(repoRoot, ".worktreeinclude"), ".env.local\n");
    execSync("git add .gitignore", { cwd: repoRoot, stdio: "ignore" });
    execSync("git commit -m 'ignore env'", { cwd: repoRoot, stdio: "ignore" });

    const manager = new WorktreeManager("test-repository", repoRoot);
    const info = manager.create("with-env");

    const copiedPath = join(info.path, ".env.local");
    expect(existsSync(copiedPath)).toBe(true);
    expect(readFileSync(copiedPath, "utf8")).toBe("SECRET=hello\n");
  });

  it("does not copy blocked dependency directories", async () => {
    writeFileSync(join(repoRoot, ".gitignore"), "node_modules/\n");
    mkdirSync(join(repoRoot, "node_modules", "some-pkg"), { recursive: true });
    writeFileSync(join(repoRoot, "node_modules", "some-pkg", "package.json"), "{}\n");
    writeFileSync(join(repoRoot, ".worktreeinclude"), "node_modules/\n");
    execSync("git add .gitignore", { cwd: repoRoot, stdio: "ignore" });
    execSync("git commit -m 'ignore node_modules'", { cwd: repoRoot, stdio: "ignore" });

    const manager = new WorktreeManager("test-repository", repoRoot);
    const info = manager.create("with-deps");

    expect(existsSync(join(info.path, "node_modules"))).toBe(false);
  });

  it("runs the setup script from marshal.json", async () => {
    writeFileSync(
      join(repoRoot, "marshal.json"),
      JSON.stringify({
        worktree: { setup: "node -e \"require('fs').writeFileSync('setup-ran', '')\"" },
      }),
    );

    const manager = new WorktreeManager("test-repository", repoRoot);
    const info = manager.create("with-setup");

    expect(existsSync(join(info.path, "setup-ran"))).toBe(true);
  });

  it("exposes environment variables to the setup script", async () => {
    const setup = `node -e "require('fs').writeFileSync('env.txt', process.env.MARSHAL_TASK_SLUG + '\\n' + process.env.MARSHAL_BRANCH_NAME + '\\n' + process.env.MARSHAL_SOURCE_CHECKOUT_PATH + '\\n' + process.env.MARSHAL_WORKTREE_PATH)"`;
    writeFileSync(join(repoRoot, "marshal.json"), JSON.stringify({ worktree: { setup } }));

    const manager = new WorktreeManager("test-repository", repoRoot);
    const info = manager.create("with-env-vars");

    const envContent = readFileSync(join(info.path, "env.txt"), "utf8");
    expect(envContent).toContain("with-env-vars");
    expect(envContent).toContain(info.branch);
    expect(envContent).toContain(repoRoot);
    expect(envContent).toContain(info.path);
  });

  it("cleans up a failed setup script", async () => {
    writeFileSync(
      join(repoRoot, "marshal.json"),
      JSON.stringify({ worktree: { setup: "exit 1" } }),
    );

    const manager = new WorktreeManager("test-repository", repoRoot);
    expect(() => manager.create("fails-setup")).toThrow("Setup script failed");

    expect(manager.list().find((w) => w.slug === "fails-setup")).toBeUndefined();
  });

  it("reuses the durable record after a manager restart", () => {
    const first = new WorktreeManager("repo-restart", repoRoot);
    const created = first.create("restart-task");
    const second = new WorktreeManager("repo-restart", repoRoot);
    expect(second.create("restart-task").path).toBe(created.path);
    expect(second.inspect("restart-task")?.id).toBe(created.id);
  });

  it("stores only a daemon-generated ID in the repository namespace", () => {
    const manager = new WorktreeManager("repo-path-shape", repoRoot);
    const info = manager.create("../../malicious/task slug");
    const namespace = ensureRepositoryNamespace("repo-path-shape");
    expect(info.path.startsWith(`${namespace.worktreesDirectory}/`)).toBe(true);
    expect(info.path.slice(namespace.worktreesDirectory.length + 1)).not.toContain("/");
    expect(info.path).not.toContain("malicious");
  });

  it("recovers an interrupted setup record on restart", () => {
    const manager = new WorktreeManager("repo-recovery", repoRoot);
    const info = manager.create("recover-me");
    const db = openDb();
    db.prepare("UPDATE worktrees SET status = 'creating' WHERE id = ?").run(info.id);
    rmSync(info.path, { recursive: true, force: true });
    const restarted = new WorktreeManager("repo-recovery", repoRoot);
    expect(restarted.inspect("recover-me")?.status).toBe("failed");
    expect(restarted.create("recover-me").path).not.toBe(info.path);
  });

  it("does not write daemon files into the source checkout", () => {
    const manager = new WorktreeManager("repo-no-source-write", repoRoot);
    manager.create("source-clean");
    expect(existsSync(join(repoRoot, ".marshal"))).toBe(false);
    expect(existsSync(join(repoRoot, "marshal.db"))).toBe(false);
  });

  it("keeps same-named repositories in separate ID namespaces", () => {
    const parent = mkdtempSync(join(tmpdir(), "marshal-same-name-"));
    const firstRoot = join(parent, "one", "project");
    const secondRoot = join(parent, "two", "project");
    mkdirSync(firstRoot, { recursive: true });
    mkdirSync(secondRoot, { recursive: true });
    initGitRepo(firstRoot);
    initGitRepo(secondRoot);
    const first = new WorktreeManager("same-name-one", firstRoot).create("same-task");
    const second = new WorktreeManager("same-name-two", secondRoot).create("same-task");
    expect(first.path).not.toBe(second.path);
    expect(first.path).toContain("repositories/same-name-one/worktrees/");
    expect(second.path).toContain("repositories/same-name-two/worktrees/");
  });

  it("repairs and reuses a worktree after checkout relocation", () => {
    const movedPath = `${repoRoot}-moved`;
    const first = new WorktreeManager("relocated-repository", repoRoot);
    const info = first.create("relocate-me");
    renameSync(repoRoot, movedPath);
    const restarted = new WorktreeManager("relocated-repository", movedPath);
    expect(restarted.inspect("relocate-me")?.sourceCheckout).toBe(movedPath);
    expect(restarted.create("relocate-me").path).toBe(info.path);
  });
});
