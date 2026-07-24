import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type BuildAppOptions } from "./http.js";
import { incrementRetryCount } from "../tasks/store.js";

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

// Drives the exact mutation surface the M1 board (Slice 6) depends on:
// POST /api/tasks, POST /api/tasks/:slug/ready, and POST /api/tasks/:slug/transition
// for the manual + escape-hatch edges in ADR-015's action map.
describe("board interactions HTTP contract", () => {
  let repoRoot: string;
  let worktreeRoot: string;
  let app: ReturnType<typeof buildApp>;
  let options: BuildAppOptions;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "marshal-board-api-"));
    worktreeRoot = mkdtempSync(join(tmpdir(), "marshal-board-api-wt-"));
    initGitRepo(repoRoot);
    options = { root: repoRoot, worktreeRoot };
    app = buildApp("0.0.1", options);
  });

  afterEach(() => {
    delete process.env.MARSHAL_GLOBAL_CONFIG;
  });

  async function createAndFreeze(
    title: string,
    spec = "## Goal\nDo it.\n",
  ): Promise<string> {
    const created = await req(app, "POST", "/api/tasks", { title, spec_markdown: spec });
    const slug = (created.body as { task: { slug: string } }).task.slug;
    await req(app, "POST", `/api/tasks/${slug}/ready`, {});
    return slug;
  }

  it("walks backlog -> ready (freeze) -> building -> validating -> review -> done", async () => {
    const slug = await createAndFreeze("Walk lifecycle");
    const toBuilding = await req(app, "POST", `/api/tasks/${slug}/transition`, { to: "building" });
    expect(toBuilding.status).toBe(200);
    expect(toBuilding.body).toMatchObject({ task: { status: "building" } });

    const toValidating = await req(app, "POST", `/api/tasks/${slug}/transition`, {
      to: "validating",
    });
    expect(toValidating.body).toMatchObject({ task: { status: "validating" } });

    const toReview = await req(app, "POST", `/api/tasks/${slug}/transition`, { to: "review" });
    expect(toReview.body).toMatchObject({ task: { status: "review" } });

    const toDone = await req(app, "POST", `/api/tasks/${slug}/transition`, { to: "done" });
    expect(toDone.body).toMatchObject({ task: { status: "done" } });
  });

  it("escape hatch building -> ready returns 200 and resets retry state", async () => {
    const slug = await createAndFreeze("Stuck build");
    await req(app, "POST", `/api/tasks/${slug}/transition`, { to: "building" });
    // Simulate prior automated failures that should be cleared by the escape hatch.
    incrementRetryCount(slug, "validator said no", repoRoot);
    incrementRetryCount(slug, "validator said no again", repoRoot);

    const escape = await req(app, "POST", `/api/tasks/${slug}/transition`, { to: "ready" });
    expect(escape.status).toBe(200);
    expect(escape.body).toMatchObject({
      task: { status: "ready", retry_count: 0, last_failure: null },
    });
  });

  it("escape hatch building -> backlog returns 200 and resets retry state", async () => {
    const slug = await createAndFreeze("Send back from build");
    await req(app, "POST", `/api/tasks/${slug}/transition`, { to: "building" });
    incrementRetryCount(slug, "boom", repoRoot);

    const escape = await req(app, "POST", `/api/tasks/${slug}/transition`, { to: "backlog" });
    expect(escape.status).toBe(200);
    expect(escape.body).toMatchObject({ task: { status: "backlog", retry_count: 0 } });
  });

  it("escape hatch validating -> backlog returns 200 and resets retry state", async () => {
    const slug = await createAndFreeze("Send back from validate");
    await req(app, "POST", `/api/tasks/${slug}/transition`, { to: "building" });
    await req(app, "POST", `/api/tasks/${slug}/transition`, { to: "validating" });
    incrementRetryCount(slug, "gate failed", repoRoot);

    const escape = await req(app, "POST", `/api/tasks/${slug}/transition`, { to: "backlog" });
    expect(escape.status).toBe(200);
    expect(escape.body).toMatchObject({
      task: { status: "backlog", retry_count: 0, last_failure: null },
    });
  });

  it("rejects the non-manual automated edges the board never offers (e.g. validating -> building is automated, but still allowed via API)", async () => {
    // The board only offers manual actions; the API still permits any valid edge,
    // including automated ones, so we assert the table rather than a UI policy.
    const slug = await createAndFreeze("Automated edge");
    await req(app, "POST", `/api/tasks/${slug}/transition`, { to: "building" });
    const automated = await req(app, "POST", `/api/tasks/${slug}/transition`, {
      to: "validating",
    });
    expect(automated.status).toBe(200);
  });

  it("returns the consistent error envelope for an invalid transition", async () => {
    const slug = await createAndFreeze("Bad edge");
    const bad = await req(app, "POST", `/api/tasks/${slug}/transition`, { to: "done" });
    expect(bad.status).toBe(409);
    expect(bad.body).toMatchObject({ code: "invalid_transition" });
    expect(typeof (bad.body as { error: string }).error).toBe("string");
  });
});
