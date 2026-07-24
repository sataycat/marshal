import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type BuildAppOptions } from "./http.js";
import { openDb } from "../db/index.js";

function initGitRepo(root: string): void {
  execSync("git init -b main", { cwd: root, stdio: "ignore" });
  execSync("git config user.email test@example.com", { cwd: root, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: root, stdio: "ignore" });
  execSync("git config core.fsmonitor false", { cwd: root, stdio: "ignore" });
  writeFileSync(join(root, "README.md"), "# Test\n");
  execSync("git add README.md", { cwd: root, stdio: "ignore" });
  execSync("git commit -m init", { cwd: root, stdio: "ignore" });
}

async function req(
  app: ReturnType<typeof buildApp>,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const init: RequestInit & { headers: Record<string, string> } = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await app.request(path, init);
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    // keep raw text
  }
  return { status: res.status, body: parsed };
}

function commitIn(path: string, file: string, content: string, msg: string): void {
  writeFileSync(join(path, file), content);
  execSync(`git add ${file}`, { cwd: path, stdio: "ignore" });
  execSync(`git commit -m ${JSON.stringify(msg)}`, { cwd: path, stdio: "ignore" });
}

// Drives the Slice 7 diff/merge contract from ADR-016:
// GET /api/tasks/:slug/diff and POST /api/tasks/:slug/merge, plus the
// review -> backlog Send Back escape hatch.
describe("diff review & merge HTTP contract", () => {
  let repoRoot: string;
  let worktreeRoot: string;
  let app: ReturnType<typeof buildApp>;
  let options: BuildAppOptions;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "marshal-diff-api-"));
    worktreeRoot = mkdtempSync(join(tmpdir(), "marshal-diff-api-wt-"));
    initGitRepo(repoRoot);
    options = { root: repoRoot, worktreeRoot };
    app = buildApp("0.0.1", options);
  });

  afterEach(() => {
    delete process.env.MARSHAL_GLOBAL_CONFIG;
  });

  async function routeToReview(title: string, spec = "## Goal\nDo it.\n"): Promise<string> {
    const created = await req(app, "POST", "/api/tasks", { title, spec_markdown: spec });
    const slug = (created.body as { task: { slug: string } }).task.slug;
    await req(app, "POST", `/api/tasks/${slug}/ready`, {});
    await req(app, "POST", `/api/tasks/${slug}/transition`, { to: "building" });
    await req(app, "POST", `/api/tasks/${slug}/transition`, { to: "validating" });
    await req(app, "POST", `/api/tasks/${slug}/transition`, { to: "review" });
    return slug;
  }

  function worktreePath(slug: string): string {
    const row = openDb(repoRoot).prepare("SELECT worktree_path FROM worktrees WHERE task_slug = ?").get(slug) as
      | { worktree_path: string }
      | undefined;
    if (!row) throw new Error(`No worktree for ${slug}`);
    return row.worktree_path;
  }

  it("returns the diff and stats for a task in review", async () => {
    const slug = await routeToReview("Diff me");
    commitIn(worktreePath(slug), "feature.txt", "hello\n", "feature");

    const res = await req(app, "GET", `/api/tasks/${slug}/diff`);
    expect(res.status).toBe(200);
    const body = res.body as { diff: string; stats: { files: number; insertions: number } };
    expect(body.diff).toContain("diff --git");
    expect(body.diff).toContain("feature.txt");
    expect(body.stats.files).toBeGreaterThanOrEqual(1);
    expect(body.stats.insertions).toBeGreaterThanOrEqual(1);
  });

  it("returns 409 diff_failed without status not in review", async () => {
    const slug = await routeToReview("Not review ready");
    await req(app, "POST", `/api/tasks/${slug}/transition`, { to: "done" });
    const res = await req(app, "GET", `/api/tasks/${slug}/diff`);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "not_review" });
  });

  it("returns 404 for an unknown task's diff", async () => {
    const res = await req(app, "GET", "/api/tasks/does-not-exist/diff");
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "task_not_found" });
  });

  it("merges the branch, transitions to done, and destroys the worktree", async () => {
    const slug = await routeToReview("Merge me");
    commitIn(worktreePath(slug), "feature.txt", "merged\n", "feature");
    const baseBefore = execSync("git rev-parse HEAD", {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    const beforeBranches = execSync("git branch --list marshal/task/*", {
      cwd: repoRoot,
      encoding: "utf8",
    });

    const res = await req(app, "POST", `/api/tasks/${slug}/merge`, {});
    expect(res.status).toBe(200);
    const body = res.body as {
      merged: boolean;
      commitSha: string;
      task: { slug: string; status: string };
    };
    expect(body.merged).toBe(true);
    expect(body.task.slug).toBe(slug);
    expect(body.task.status).toBe("done");
    expect(body.commitSha).not.toBe(baseBefore);

    // Merge commit landed on the base branch.
    const log = execSync("git log --oneline", { cwd: repoRoot, encoding: "utf8" });
    expect(log).toContain(`merge: ${slug}`);
    // Task branch has been deleted by WorktreeManager.destroy.
    const afterBranches = execSync("git branch --list marshal/task/*", {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(beforeBranches.length).toBeGreaterThan(afterBranches.length);
    expect(afterBranches).not.toContain(slug);
    // Task is now Done in the store.
    const detail = await req(app, "GET", `/api/tasks/${slug}`);
    expect(detail.body).toMatchObject({ task: { status: "done" } });
  });

  it("returns merge_conflict 409 and keeps task in review on a conflicting merge", async () => {
    const slug = await routeToReview("Conflict me");
    commitIn(worktreePath(slug), "feature.txt", "branch side\n", "branch side");
    // Diverge the base branch after the worktree was created so the merge conflicts.
    writeFileSync(join(repoRoot, "feature.txt"), "base side\n");
    execSync("git add feature.txt", { cwd: repoRoot, stdio: "ignore" });
    execSync(`git commit -m ${JSON.stringify("base side")}`, { cwd: repoRoot, stdio: "ignore" });

    const res = await req(app, "POST", `/api/tasks/${slug}/merge`, {});
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "merge_conflict" });
    // Task should remain in review.
    const detail = await req(app, "GET", `/api/tasks/${slug}`);
    expect(detail.body).toMatchObject({ task: { status: "review" } });
    // Source should not be left in a conflicted state.
    const status = execSync("git status --porcelain", { cwd: repoRoot, encoding: "utf8" });
    expect(status).not.toContain("UU");
  });

  it("send back from review via transition to backlog is an escape hatch", async () => {
    const slug = await routeToReview("Send me back");
    const res = await req(app, "POST", `/api/tasks/${slug}/transition`, { to: "backlog" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      task: { status: "backlog", retry_count: 0, last_failure: null },
    });
  });
});
