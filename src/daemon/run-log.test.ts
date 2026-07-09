import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "../agent/types.js";
import { createTask } from "../tasks/store.js";
import { RunLog, type RunEventRecord, type RunRecord } from "./run-log.js";

describe("RunLog", () => {
  let root: string;
  let taskId: number;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "marshal-runlog-"));
    const task = createTask({ slug: "log-task", title: "Log", specMarkdown: "x" }, root);
    taskId = task.id;
  });

  it("startRun creates a row in running state and returns the run id", () => {
    const log = new RunLog(root);
    const runId = log.startRun(taskId, "builder", "opencode", "do the thing");

    expect(runId).toBeGreaterThan(0);

    const run = log.getRun(runId);
    expect(run).toBeDefined();
    expect(run?.taskId).toBe(taskId);
    expect(run?.role).toBe("builder");
    expect(run?.agentId).toBe("opencode");
    expect(run?.status).toBe("running");
    expect(run?.prompt).toBe("do the thing");
    expect(run?.commitSha).toBeNull();
    expect(run?.endedAt).toBeNull();
    expect(run?.error).toBeNull();
  });

  it("insertEvent stores events with their seq and JSON payload", () => {
    const log = new RunLog(root);
    const runId = log.startRun(taskId, "builder", "opencode", "p");

    const events: AgentEvent[] = [
      { type: "text", text: "hello" },
      { type: "thinking", text: "hmm" },
      { type: "tool", title: "Read", status: "completed", output: "ok" },
      { type: "done", stopReason: "end_turn" },
    ];
    events.forEach((ev, seq) => log.insertEvent(runId, seq, ev));

    const stored = log.getEvents(runId);
    expect(stored).toHaveLength(4);
    expect(stored.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(stored.map((e) => e.type)).toEqual(["text", "thinking", "tool", "done"]);
    expect(stored[0].payload).toEqual({ type: "text", text: "hello" });
    expect(stored[2].payload).toEqual({
      type: "tool",
      title: "Read",
      status: "completed",
      output: "ok",
    });
    expect(stored[3].payload).toEqual({ type: "done", stopReason: "end_turn" });
  });

  it("finishRun with done records the commit sha and ended_at", () => {
    const log = new RunLog(root);
    const runId = log.startRun(taskId, "builder", "opencode", "p");

    log.finishRun(runId, "done", { commitSha: "abc123" });

    const run = log.getRun(runId);
    expect(run?.status).toBe("done");
    expect(run?.commitSha).toBe("abc123");
    expect(run?.endedAt).not.toBeNull();
    expect(run?.error).toBeNull();
  });

  it("finishRun with error records the error message and ended_at", () => {
    const log = new RunLog(root);
    const runId = log.startRun(taskId, "builder", "opencode", "p");

    log.finishRun(runId, "error", { error: "boom" });

    const run = log.getRun(runId);
    expect(run?.status).toBe("error");
    expect(run?.error).toBe("boom");
    expect(run?.endedAt).not.toBeNull();
    expect(run?.commitSha).toBeNull();
  });

  it("finishRun without options only flips status and sets ended_at", () => {
    const log = new RunLog(root);
    const runId = log.startRun(taskId, "builder", "opencode", "p");

    log.finishRun(runId, "done");

    const run = log.getRun(runId);
    expect(run?.status).toBe("done");
    expect(run?.commitSha).toBeNull();
    expect(run?.error).toBeNull();
    expect(run?.endedAt).not.toBeNull();
  });

  it("getRun returns undefined for an unknown run id", () => {
    const log = new RunLog(root);
    expect(log.getRun(99999)).toBeUndefined();
  });

  it("getEvents returns [] for a run with no events", () => {
    const log = new RunLog(root);
    const runId = log.startRun(taskId, "builder", "opencode", "p");
    expect(log.getEvents(runId)).toEqual([]);
  });

  it("stores multiple runs per task and preserves their order", () => {
    const log = new RunLog(root);
    const first = log.startRun(taskId, "builder", "opencode", "first");
    const second = log.startRun(taskId, "builder", "opencode", "second");

    expect(second).toBeGreaterThan(first);

    expect(log.getRun(first)?.prompt).toBe("first");
    expect(log.getRun(second)?.prompt).toBe("second");
  });

  it("getLastRunForTask returns the most recent run for a task", () => {
    const log = new RunLog(root);
    const first = log.startRun(taskId, "builder", "opencode", "first");
    log.finishRun(first, "error", { error: "boom" });
    const second = log.startRun(taskId, "validator", "pi", "second");
    log.finishRun(second, "done", { commitSha: "cafe" });

    const last = log.getLastRunForTask(taskId);
    expect(last?.id).toBe(second);
    expect(last?.role).toBe("validator");
    expect(last?.status).toBe("done");
  });

  it("getLastRunForTask returns a run with an error for a stuck task", () => {
    const log = new RunLog(root);
    const runId = log.startRun(taskId, "builder", "opencode", "build");
    log.finishRun(runId, "error", { error: "spawn failed: acpx missing" });

    const last = log.getLastRunForTask(taskId);
    expect(last?.id).toBe(runId);
    expect(last?.status).toBe("error");
    expect(last?.error).toBe("spawn failed: acpx missing");
  });

  it("getLastRunForTask returns undefined when the task has no runs", () => {
    const log = new RunLog(root);
    expect(log.getLastRunForTask(taskId)).toBeUndefined();
  });

  it("round-trips an error event payload with a numeric code", () => {
    const log = new RunLog(root);
    const runId = log.startRun(taskId, "builder", "opencode", "p");
    const event: AgentEvent = { type: "error", message: "timeout", code: 3 };
    log.insertEvent(runId, 0, event);

    const stored = log.getEvents(runId);
    expect(stored[0].payload).toEqual({ type: "error", message: "timeout", code: 3 });
  });

  it("RunRecord and RunEventRecord shapes are stable across reads", () => {
    const log = new RunLog(root);
    const runId = log.startRun(taskId, "builder", "opencode", "prompt text");
    log.insertEvent(runId, 0, { type: "text", text: "a" });
    log.finishRun(runId, "done", { commitSha: "deadbeef" });

    const run: RunRecord | undefined = log.getRun(runId);
    const events: RunEventRecord[] = log.getEvents(runId);

    expect(run).toMatchObject({
      id: runId,
      taskId,
      role: "builder",
      agentId: "opencode",
      status: "done",
      prompt: "prompt text",
      commitSha: "deadbeef",
      endedAt: expect.any(String),
      error: null,
    });
    expect(events[0]).toMatchObject({
      runId,
      seq: 0,
      type: "text",
      payload: { type: "text", text: "a" },
      createdAt: expect.any(String),
    });
  });

  it("listRunsForTask returns all runs for a task, newest first", () => {
    const log = new RunLog(root);
    const first = log.startRun(taskId, "builder", "opencode", "first");
    log.finishRun(first, "error", { error: "boom" });
    const second = log.startRun(taskId, "validator", "pi", "second");
    log.finishRun(second, "done", { commitSha: "cafe" });

    const runs = log.listRunsForTask(taskId);
    expect(runs.map((r) => r.id)).toEqual([second, first]);
    expect(runs[0].role).toBe("validator");
    expect(runs[1].role).toBe("builder");
  });

  it("listRunsForTask returns [] when the task has no runs", () => {
    const log = new RunLog(root);
    expect(log.listRunsForTask(taskId)).toEqual([]);
  });

  it("getEvents paginates by afterSeq and limit", () => {
    const log = new RunLog(root);
    const runId = log.startRun(taskId, "builder", "opencode", "p");
    const events: AgentEvent[] = Array.from({ length: 5 }, (_, i) => ({
      type: "text",
      text: `line ${i}`,
    }));
    events.forEach((ev, seq) => log.insertEvent(runId, seq, ev));

    const page1 = log.getEvents(runId, { afterSeq: 0, limit: 2 });
    expect(page1.map((e) => e.seq)).toEqual([1, 2]);

    const page2 = log.getEvents(runId, { afterSeq: 2, limit: 2 });
    expect(page2.map((e) => e.seq)).toEqual([3, 4]);

    const beyond = log.getEvents(runId, { afterSeq: 4, limit: 2 });
    expect(beyond).toEqual([]);
  });

  it("getEvents defaults to afterSeq=0 and limit=100", () => {
    const log = new RunLog(root);
    const runId = log.startRun(taskId, "builder", "opencode", "p");
    const events: AgentEvent[] = Array.from({ length: 150 }, (_, i) => ({
      type: "text",
      text: `line ${i}`,
    }));
    events.forEach((ev, seq) => log.insertEvent(runId, seq, ev));

    const stored = log.getEvents(runId);
    expect(stored).toHaveLength(100);
    expect(stored[0].seq).toBe(0);
    expect(stored[99].seq).toBe(99);
  });
});
