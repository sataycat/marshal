import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type BuildAppOptions } from "./http.js";
import { openDb } from "../db/index.js";
import { WorktreeManager } from "../worktree/manager.js";

function repositoryId(root: string): string {
  return (openDb(root).prepare("SELECT id FROM repositories WHERE path = ?").get(root) as { id: string }).id;
}

function initGitRepo(root: string): void {
  execSync("git init -b main", { cwd: root, stdio: "ignore" });
  execSync("git config user.email test@example.com", { cwd: root, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: root, stdio: "ignore" });
  writeFileSync(join(root, "README.md"), "# Test\n");
  execSync("git add README.md", { cwd: root, stdio: "ignore" });
  execSync("git commit -m init", { cwd: root, stdio: "ignore" });
}

async function req(
  app: ReturnType<typeof buildApp>,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown; text: string }> {
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
  return { status: res.status, body: parsed, text };
}

describe("task CRUD API", () => {
  let repoRoot: string;
  let worktreeRoot: string;
  let app: ReturnType<typeof buildApp>;
  let options: BuildAppOptions;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "marshal-task-api-"));
    worktreeRoot = mkdtempSync(join(tmpdir(), "marshal-task-api-wt-"));
    initGitRepo(repoRoot);
    options = { root: repoRoot, worktreeRoot };
    app = buildApp("0.0.1", options);
  });

  afterEach(() => {
    delete process.env.MARSHAL_GLOBAL_CONFIG;
  });

  it("returns an empty task list when nothing exists", async () => {
    const { status, body } = await req(app, "GET", "/api/tasks");
    expect(status).toBe(200);
    expect(body).toEqual({ tasks: [] });
  });

  it("creates a task with an auto-generated slug and returns it", async () => {
    const { status, body } = await req(app, "POST", "/api/tasks", {
      title: "Add Greeting",
      spec_markdown: "## Goal\nSay hi.\n",
    });
    expect(status).toBe(201);
    const task = (body as { task: { slug: string; title: string; status: string; spec_markdown: string } }).task;
    expect(task.slug).toBe("add-greeting");
    expect(task.title).toBe("Add Greeting");
    expect(task.status).toBe("backlog");
    expect(task.spec_markdown).toBe("## Goal\nSay hi.\n");

    const list = await req(app, "GET", "/api/tasks");
    expect(list.body).toMatchObject({ tasks: [{ slug: "add-greeting", status: "backlog" }] });
  });

  it("accepts the repository ID in the create body", async () => {
    const id = repositoryId(repoRoot);
    const { status, body } = await req(app, "POST", "/api/tasks", {
      repository_id: id,
      title: "Body scoped task",
      spec_markdown: "body scope",
    });
    expect(status).toBe(201);
    expect(body).toMatchObject({ task: { repository_id: id, title: "Body scoped task" } });
  });

  it("disambiguates duplicate titles by appending a numeric suffix", async () => {
    await req(app, "POST", "/api/tasks", { title: "Add Greeting" });
    const second = await req(app, "POST", "/api/tasks", { title: "Add Greeting" });
    expect(second.body).toMatchObject({ task: { slug: "add-greeting-2" } });
  });

  it("returns full detail via GET /api/tasks/:slug", async () => {
    await req(app, "POST", "/api/tasks", { title: "Inspect me", spec_markdown: "body" });
    const { status, body } = await req(app, "GET", "/api/tasks/inspect-me");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      task: {
        slug: "inspect-me",
        title: "Inspect me",
        status: "backlog",
        spec_markdown: "body",
        retry_count: 0,
        last_failure: null,
      },
    });
  });
  it("returns card fields (no spec) on the list endpoint", async () => {
    await req(app, "POST", "/api/tasks", { title: "Card only", spec_markdown: "secret" });
    const { body } = await req(app, "GET", "/api/tasks");
    const task = (body as { tasks: Record<string, unknown>[] }).tasks[0];
    expect(task).toHaveProperty("id");
    expect(task).toHaveProperty("slug");
    expect(task).toHaveProperty("title");
    expect(task).toHaveProperty("status");
    expect(task).toHaveProperty("retry_count");
    expect(task).toHaveProperty("created_at");
    expect(task).toHaveProperty("updated_at");
    expect(task).not.toHaveProperty("spec_markdown");
    expect(task).not.toHaveProperty("last_failure");
  });

  it("rejects creation with an empty title (422)", async () => {
    const { status, body } = await req(app, "POST", "/api/tasks", { title: "   " });
    expect(status).toBe(422);
    expect(body).toMatchObject({ error: expect.any(String), code: "invalid_field" });
  });

  it("rejects creation with an unknown field (400)", async () => {
    const { status, body } = await req(app, "POST", "/api/tasks", { title: "x", slug: "nope" });
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: "unknown_field" });
  });

  it("rejects a malformed JSON body (400)", async () => {
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_json" });
  });

  it("returns 404 for an unknown task slug", async () => {
    const { status, body } = await req(app, "GET", "/api/tasks/ghost");
    expect(status).toBe(404);
    expect(body).toMatchObject({ code: "task_not_found" });
  });

  it("transitions a task through POST /api/tasks/:slug/transition", async () => {
    const created = await req(app, "POST", "/api/tasks", { title: "Move me" });
    const slug = (created.body as { task: { slug: string } }).task.slug;
    const { status, body } = await req(app, "POST", `/api/tasks/${slug}/transition`, {
      to: "ready",
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ task: { slug, status: "ready" } });
  });

  it("rejects an invalid transition with 409", async () => {
    const created = await req(app, "POST", "/api/tasks", { title: "Skip" });
    const slug = (created.body as { task: { slug: string } }).task.slug;
    const { status, body } = await req(app, "POST", `/api/tasks/${slug}/transition`, {
      to: "done",
    });
    expect(status).toBe(409);
    expect(body).toMatchObject({ code: "invalid_transition" });
  });

  it("rejects transition to an unknown status with 422", async () => {
    const created = await req(app, "POST", "/api/tasks", { title: "Bad status" });
    const slug = (created.body as { task: { slug: string } }).task.slug;
    const { status, body } = await req(app, "POST", `/api/tasks/${slug}/transition`, {
      to: "frozen",
    });
    expect(status).toBe(422);
    expect(body).toMatchObject({ code: "unknown_status" });
  });

  it("rejects transition body missing 'to' with 422", async () => {
    const created = await req(app, "POST", "/api/tasks", { title: "Missing to" });
    const slug = (created.body as { task: { slug: string } }).task.slug;
    const { status, body } = await req(app, "POST", `/api/tasks/${slug}/transition`, {});
    expect(status).toBe(422);
    expect(body).toMatchObject({ code: "missing_field" });
  });

  it("freezes spec and creates a worktree via /api/tasks/:slug/ready", async () => {
    const created = await req(app, "POST", "/api/tasks", {
      title: "Ready task",
      spec_markdown: "## Goal\nDo it.\n",
    });
    const slug = (created.body as { task: { slug: string } }).task.slug;

    const { status, body } = await req(app, "POST", `/api/tasks/${slug}/ready`, {});
    expect(status).toBe(200);
    expect(body).toMatchObject({ task: { slug, status: "ready" } });

    // Task is now ready in the DB.
    const db = openDb(repoRoot);
    const row = db.prepare("SELECT status FROM tasks WHERE slug = ?").get(slug) as { status: string };
    expect(row.status).toBe("ready");

    // A worktree index entry was recorded for this slug.
    const manager = new WorktreeManager(repositoryId(repoRoot), repoRoot);
    expect(manager.list().map((w) => w.slug)).toContain(slug);
  });

  it("lets /ready override the stored spec before freezing", async () => {
    const created = await req(app, "POST", "/api/tasks", {
      title: "Override spec",
      spec_markdown: "old body",
    });
    const slug = (created.body as { task: { slug: string } }).task.slug;

    const { status } = await req(app, "POST", `/api/tasks/${slug}/ready`, {
      specMarkdown: "## Goal\nNew body.\n",
    });
    expect(status).toBe(200);

    const db = openDb(repoRoot);
    const row = db.prepare("SELECT spec_markdown FROM tasks WHERE slug = ?").get(slug) as {
      spec_markdown: string;
    };
    expect(row.spec_markdown).toBe("## Goal\nNew body.\n");
  });

  it("returns 409 when freezing a task with an empty spec", async () => {
    const created = await req(app, "POST", "/api/tasks", { title: "No spec" });
    const slug = (created.body as { task: { slug: string } }).task.slug;
    const { status, body } = await req(app, "POST", `/api/tasks/${slug}/ready`, {});
    expect(status).toBe(409);
    expect(body).toMatchObject({ code: "freeze_failed" });
  });

  it("rejects /ready with an unknown field (400)", async () => {
    const created = await req(app, "POST", "/api/tasks", { title: "Strict" });
    const slug = (created.body as { task: { slug: string } }).task.slug;
    const { status, body } = await req(app, "POST", `/api/tasks/${slug}/ready`, {
      spec_markdown: "wrong casing",
    });
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: "unknown_field" });
  });

  it("marks the acceptance flow: create, list, freeze, observe worktree", async () => {
    const created = await req(app, "POST", "/api/tasks", {
      title: "Slice Two Acceptance",
      spec_markdown: "## Goal\nLand Slice 2.\n",
    });
    const slug = (created.body as { task: { slug: string } }).task.slug;
    expect(created.status).toBe(201);

    const listed = await req(app, "GET", "/api/tasks");
    expect(listed.status).toBe(200);
    expect((listed.body as { tasks: { slug: string }[] }).tasks[0].slug).toBe(slug);

    const froze = await req(app, "POST", `/api/tasks/${slug}/ready`, {});
    expect(froze.status).toBe(200);
    expect((froze.body as { task: { status: string } }).task.status).toBe("ready");

    const manager = new WorktreeManager(repositoryId(repoRoot), repoRoot);
    const worktree = manager.list().find((w) => w.slug === slug);
    expect(worktree, "worktree must be created on /ready").toBeDefined();
    expect(existsSync(worktree!.path)).toBe(true);
  });
});
