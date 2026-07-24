import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type BuildAppOptions } from "./http.js";
import { createTask, getTask, transitionTask } from "../tasks/store.js";
import { RunLog } from "./run-log.js";
import type { AgentEvent } from "../agent/types.js";

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

describe("run history API", () => {
  let repoRoot: string;
  let app: ReturnType<typeof buildApp>;
  let options: BuildAppOptions;
  let taskId: number;
  let runId: number;
  let log: RunLog;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "marshal-run-api-"));
    initGitRepo(repoRoot);
    options = { root: repoRoot };
    app = buildApp("0.0.1", options);
    const task = createTask(
      { slug: "build-thing", title: "Build thing", specMarkdown: "## Goal\nDo it.\n" },
      repoRoot,
    );
    taskId = task.id;
    log = new RunLog(repoRoot);
    runId = log.startRun(taskId, "builder", "opencode", "build prompt");
  });

  afterEach(() => {
    delete process.env.MARSHAL_GLOBAL_CONFIG;
  });

  it("GET /api/tasks/:slug/runs lists runs for a task in snake_case", async () => {
    const finishedSecond = log.startRun(taskId, "validator", "pi", "validate");
    log.finishRun(finishedSecond, "done", { commitSha: "cafe" });

    const { status, body } = await req(app, "GET", "/api/tasks/build-thing/runs");
    expect(status).toBe(200);
    const runs = (body as { runs: Record<string, unknown>[] }).runs;
    expect(runs).toHaveLength(2);
    // newest first
    expect(runs[0]).toMatchObject({
      id: finishedSecond,
      task_id: taskId,
      role: "validator",
      agent_id: "pi",
      status: "done",
      commit_sha: "cafe",
      error: null,
    });
    expect(runs[0]).not.toHaveProperty("prompt");
    expect(runs[1]).toMatchObject({ id: runId, role: "builder", status: "running" });
  });

  it("GET /api/tasks/:slug/runs returns 404 for an unknown slug", async () => {
    const { status, body } = await req(app, "GET", "/api/tasks/ghost/runs");
    expect(status).toBe(404);
    expect(body).toMatchObject({ code: "task_not_found" });
  });

  it("GET /api/runs/:id returns the run with prompt in detail", async () => {
    const { status, body } = await req(app, "GET", `/api/runs/${runId}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      run: {
        id: runId,
        task_id: taskId,
        role: "builder",
        agent_id: "opencode",
        status: "running",
        prompt: "build prompt",
        commit_sha: null,
        error: null,
        ended_at: null,
      },
    });
  });
  it("explicitly resolves an auth-required run while retaining immutable evidence", async () => {
    transitionTask("build-thing", "ready", repoRoot); transitionTask("build-thing", "building", repoRoot);
    const failure = { kind: "authentication_required" as const, message: "Sign in", protocol_code: -32000, data: null }; log.finishRun(runId, "authentication_required", { error: failure.message, failure });
    const recovered = await req(app, "POST", `/api/runs/${runId}/recover-authentication`); expect(recovered).toMatchObject({ status: 200, body: { run: { id: runId, status: "authentication_required", failure, auth_recovery_resolved_at: expect.any(String), superseded_by_run_id: null } } });
    expect(getTask("build-thing", repoRoot).status).toBe("ready");
    const superseding = log.startRun(taskId, "builder", "opencode", "new explicit attempt"); expect(log.getRun(runId)).toMatchObject({ status: "authentication_required", prompt: "build prompt", failure, supersededByRunId: superseding });
  });
  it("preserves validator dispatch state during explicit authentication recovery", async () => { log.finishRun(runId, "done"); transitionTask("build-thing", "ready", repoRoot); transitionTask("build-thing", "building", repoRoot); transitionTask("build-thing", "validating", repoRoot); const validator = log.startRun(taskId, "validator", "pi", "validate"); log.finishRun(validator, "authentication_required", { error: "Sign in", failure: { kind: "authentication_required", message: "Sign in", protocol_code: -32000, data: null } }); const result = await req(app, "POST", `/api/runs/${validator}/recover-authentication`); expect(result.status).toBe(200); expect(getTask("build-thing", repoRoot).status).toBe("validating"); });
  it("rejects stale recovery when the owning task moved", async () => { transitionTask("build-thing", "ready", repoRoot); transitionTask("build-thing", "building", repoRoot); log.finishRun(runId, "authentication_required", { error: "Sign in", failure: { kind: "authentication_required", message: "Sign in", protocol_code: -32000, data: null } }); transitionTask("build-thing", "backlog", repoRoot); const result = await req(app, "POST", `/api/runs/${runId}/recover-authentication`); expect(result).toMatchObject({ status: 409, body: { code: "run_not_authentication_required" } }); });
  it("rejects recovery for an ordinary run", async () => { const result = await req(app, "POST", `/api/runs/${runId}/recover-authentication`); expect(result).toMatchObject({ status: 409, body: { code: "run_not_authentication_required" } }); });

  it("GET /api/runs/:id returns 404 for an unknown run", async () => {
    const { status, body } = await req(app, "GET", "/api/runs/99999");
    expect(status).toBe(404);
    expect(body).toMatchObject({ code: "run_not_found" });
  });

  it("GET /api/runs/:id rejects a non-numeric id with 400", async () => {
    const { status, body } = await req(app, "GET", "/api/runs/not-a-number");
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: "invalid_run_id" });
  });

  it("GET /api/runs/:id/events returns paginated events ordered by seq", async () => {
    const events: AgentEvent[] = [
      { type: "text", text: "hello" },
      { type: "thinking", text: "hmm" },
      { type: "tool", title: "Read", status: "completed", output: "ok" },
      { type: "done", stopReason: "end_turn" },
    ];
    events.forEach((ev, seq) => log.insertEvent(runId, seq, ev));

    const { status, body } = await req(app, "GET", `/api/runs/${runId}/events`);
    expect(status).toBe(200);
    const parsed = body as {
      events: { seq: number; type: string; payload: unknown }[];
      next_after_seq: number;
    };
    expect(parsed.events).toHaveLength(4);
    expect(parsed.events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(parsed.events.map((e) => e.type)).toEqual(["text", "thinking", "tool", "done"]);
    expect(parsed.events[0].payload).toEqual({ type: "text", text: "hello" });
    expect(parsed.next_after_seq).toBe(3);
  });

  it("paginates events with after_seq and limit", async () => {
    const events: AgentEvent[] = Array.from({ length: 5 }, (_, i) => ({
      type: "text",
      text: `line ${i}`,
    }));
    events.forEach((ev, seq) => log.insertEvent(runId, seq, ev));

    const first = await req(app, "GET", `/api/runs/${runId}/events?limit=2`);
    const firstBody = first.body as { events: { seq: number }[]; next_after_seq: number };
    expect(first.status).toBe(200);
    expect(firstBody.events.map((e) => e.seq)).toEqual([0, 1]);
    expect(firstBody.next_after_seq).toBe(1);

    const second = await req(
      app,
      "GET",
      `/api/runs/${runId}/events?after_seq=${firstBody.next_after_seq}&limit=2`,
    );
    const secondBody = second.body as { events: { seq: number }[]; next_after_seq: number };
    expect(second.status).toBe(200);
    expect(secondBody.events.map((e) => e.seq)).toEqual([2, 3]);
    expect(secondBody.next_after_seq).toBe(3);

    const third = await req(
      app,
      "GET",
      `/api/runs/${runId}/events?after_seq=${secondBody.next_after_seq}&limit=2`,
    );
    const thirdBody = third.body as { events: { seq: number }[]; next_after_seq: number };
    expect(third.status).toBe(200);
    expect(thirdBody.events.map((e) => e.seq)).toEqual([4]);
    expect(thirdBody.next_after_seq).toBe(4);

    const beyond = await req(
      app,
      "GET",
      `/api/runs/${runId}/events?after_seq=${thirdBody.next_after_seq}&limit=2`,
    );
    const beyondBody = beyond.body as { events: unknown[]; next_after_seq: null };
    expect(beyond.status).toBe(200);
    expect(beyondBody.events).toEqual([]);
    expect(beyondBody.next_after_seq).toBeNull();
  });

  it("returns events from the beginning when after_seq is omitted", async () => {
    log.insertEvent(runId, 0, { type: "text", text: "first" });
    const { status, body } = await req(app, "GET", `/api/runs/${runId}/events`);
    expect(status).toBe(200);
    expect((body as { events: { seq: number }[] }).events.map((e) => e.seq)).toEqual([0]);
  });

  it("after_seq=0 returns events with seq greater than 0", async () => {
    const events: AgentEvent[] = [
      { type: "text", text: "first" },
      { type: "text", text: "second" },
      { type: "text", text: "third" },
    ];
    events.forEach((ev, seq) => log.insertEvent(runId, seq, ev));
    const { status, body } = await req(app, "GET", `/api/runs/${runId}/events?after_seq=0`);
    expect(status).toBe(200);
    expect((body as { events: { seq: number }[] }).events.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("limit defaults to 100", async () => {
    const events: AgentEvent[] = Array.from({ length: 150 }, (_, i) => ({
      type: "text",
      text: `line ${i}`,
    }));
    events.forEach((ev, seq) => log.insertEvent(runId, seq, ev));

    const { status, body } = await req(app, "GET", `/api/runs/${runId}/events`);
    expect(status).toBe(200);
    expect((body as { events: unknown[] }).events).toHaveLength(100);
  });

  it("rejects limit > 500 with 422", async () => {
    const { status, body } = await req(app, "GET", `/api/runs/${runId}/events?limit=501`);
    expect(status).toBe(422);
    expect(body).toMatchObject({ code: "invalid_limit" });
  });

  it("rejects a malformed after_seq with 400", async () => {
    const { status, body } = await req(app, "GET", `/api/runs/${runId}/events?after_seq=abc`);
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: "invalid_query" });
  });

  it("rejects a negative limit with 400", async () => {
    const { status, body } = await req(app, "GET", `/api/runs/${runId}/events?limit=-1`);
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: "invalid_query" });
  });

  it("returns 404 for events of an unknown run", async () => {
    const { status, body } = await req(app, "GET", "/api/runs/99999/events");
    expect(status).toBe(404);
    expect(body).toMatchObject({ code: "run_not_found" });
  });

  it("acceptance: trigger a build flow output via recorded run events", async () => {
    // Simulate an orchestrator-style builder run that streams output.
    const events: AgentEvent[] = [
      { type: "text", text: "planning" },
      { type: "tool", title: "Write", status: "completed", output: "src/greet.ts" },
      { type: "text", text: "done" },
    ];
    events.forEach((ev, seq) => log.insertEvent(runId, seq, ev));
    log.finishRun(runId, "done", { commitSha: "abc123" });

    const { status, body } = await req(app, "GET", `/api/runs/${runId}/events`);
    expect(status).toBe(200);
    const parsed = body as { events: { type: string }[] };
    expect(parsed.events.map((e) => e.type)).toEqual(["text", "tool", "text"]);

    const run = await req(app, "GET", `/api/runs/${runId}`);
    expect((run.body as { run: { status: string; commit_sha: string } }).run).toMatchObject({
      status: "done",
      commit_sha: "abc123",
    });
  });
});
