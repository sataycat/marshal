import { describe, expect, it } from "vitest";
import { renderTaskShow } from "./commands.js";
import type { Task } from "./store.js";
import type { RunRecord } from "../daemon/run-log.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    slug: "add-thing",
    title: "Add the thing",
    status: "backlog",
    spec_markdown: "",
    retry_count: 0,
    last_failure: null,
    created_at: "2026-07-08 12:00:00",
    updated_at: "2026-07-08 12:00:00",
    ...overrides,
  };
}

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 7,
    taskId: 1,
    role: "builder",
    agentId: "opencode",
    status: "error",
    prompt: null,
    commitSha: null,
    startedAt: "2026-07-08 12:01:00",
    endedAt: "2026-07-08 12:02:00",
    error: "spawn failed: acpx missing",
    ...overrides,
  };
}

describe("renderTaskShow", () => {
  it("renders the base fields", () => {
    const out = renderTaskShow(makeTask());
    expect(out).toContain("slug:   add-thing");
    expect(out).toContain("title:  Add the thing");
    expect(out).toContain("status: backlog");
    expect(out).toContain("id:     1");
    expect(out).toContain("retries: 0");
    expect(out).toContain("created: 2026-07-08 12:00:00");
    expect(out).toContain("updated: 2026-07-08 12:00:00");
  });

  it("shows the last failure line when last_failure is set", () => {
    const out = renderTaskShow(makeTask({ last_failure: "tests are red" }));
    expect(out).toContain("last failure: tests are red");
  });

  it("omits the last failure line when last_failure is null", () => {
    const out = renderTaskShow(makeTask());
    expect(out).not.toMatch(/last failure/);
  });

  it("shows last run and run error when stuck in building with an error run", () => {
    const out = renderTaskShow(
      makeTask({ status: "building" }),
      makeRun({ id: 7, role: "builder", agentId: "opencode", status: "error", error: "spawn failed: acpx missing" }),
    );
    expect(out).toContain("last run: #7 builder opencode error");
    expect(out).toContain("run error: spawn failed: acpx missing");
  });

  it("shows last run and run error when stuck in validating with an error run", () => {
    const out = renderTaskShow(
      makeTask({ status: "validating" }),
      makeRun({ id: 9, role: "validator", agentId: "pi", status: "error", error: "tests are red" }),
    );
    expect(out).toContain("last run: #9 validator pi error");
    expect(out).toContain("run error: tests are red");
  });

  it("shows the last run line without run error when the run has no error", () => {
    const out = renderTaskShow(
      makeTask({ status: "building" }),
      makeRun({ status: "running", error: null }),
    );
    expect(out).toContain("last run: #7 builder opencode running");
    expect(out).not.toMatch(/run error/);
  });

  it("does not show last run lines when the task is not stuck", () => {
    const out = renderTaskShow(
      makeTask({ status: "ready" }),
      makeRun(),
    );
    expect(out).not.toMatch(/last run/);
    expect(out).not.toMatch(/run error/);
  });

  it("does not show last run lines when stuck but no run exists", () => {
    const out = renderTaskShow(makeTask({ status: "building" }));
    expect(out).not.toMatch(/last run/);
    expect(out).not.toMatch(/run error/);
  });

  it("shows both last failure and run error when both are present", () => {
    const out = renderTaskShow(
      makeTask({ status: "validating", last_failure: "gate reason" }),
      makeRun({ role: "validator", agentId: "pi", status: "error", error: "no gate decision emitted" }),
    );
    expect(out).toContain("last failure: gate reason");
    expect(out).toContain("run error: no gate decision emitted");
  });

  it("renders the spec section when spec_markdown is present", () => {
    const out = renderTaskShow(makeTask({ spec_markdown: "## Goal\nDo it.\n" }));
    expect(out).toContain("--- spec ---");
    expect(out).toContain("## Goal\nDo it.");
  });

  it("omits the spec section when spec_markdown is empty", () => {
    const out = renderTaskShow(makeTask({ spec_markdown: "" }));
    expect(out).not.toMatch(/--- spec ---/);
  });
});
