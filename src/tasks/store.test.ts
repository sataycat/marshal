import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { InvalidTransitionError } from "./state-machine.js";
import {
  clearRetryState,
  createTask,
  DuplicateSlugError,
  getTask,
  incrementRetryCount,
  listTasks,
  setLastFailure,
  TaskNotFoundError,
  transitionTask,
} from "./store.js";

describe("task store", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "marshal-store-"));
  });

  it("creates a task in backlog", () => {
    const t = createTask({ slug: "add-greeting", title: "Add greeting" }, root);
    expect(t.slug).toBe("add-greeting");
    expect(t.status).toBe("backlog");
    expect(t.spec_markdown).toBe("");
    expect(t.retry_count).toBe(0);
    expect(t.last_failure).toBeNull();

    const fetched = getTask("add-greeting", root);
    expect(fetched.id).toBe(t.id);
    expect(fetched.title).toBe("Add greeting");
  });

  it("stores spec markdown when provided", () => {
    createTask({ slug: "with-spec", title: "Spec", specMarkdown: "# do x\n" }, root);
    expect(getTask("with-spec", root).spec_markdown).toBe("# do x\n");
  });

  it("rejects duplicate slugs", () => {
    createTask({ slug: "dup", title: "first" }, root);
    expect(() => createTask({ slug: "dup", title: "second" }, root)).toThrow(DuplicateSlugError);
  });

  it("throws TaskNotFoundError for unknown slug", () => {
    expect(() => getTask("missing", root)).toThrow(TaskNotFoundError);
  });

  it("transitions through the happy path", () => {
    createTask({ slug: "happy", title: "Happy" }, root);
    transitionTask("happy", "ready", root);
    transitionTask("happy", "building", root);
    transitionTask("happy", "validating", root);
    transitionTask("happy", "review", root);
    expect(getTask("happy", root).status).toBe("review");
    transitionTask("happy", "done", root);
    expect(getTask("happy", root).status).toBe("done");
  });

  it("supports validating -> building retry", () => {
    createTask({ slug: "retry", title: "Retry" }, root);
    transitionTask("retry", "ready", root);
    transitionTask("retry", "building", root);
    transitionTask("retry", "validating", root);
    transitionTask("retry", "building", root);
    expect(getTask("retry", root).status).toBe("building");
  });

  it("rejects invalid transitions", () => {
    createTask({ slug: "bad", title: "Bad" }, root);
    expect(() => transitionTask("bad", "done", root)).toThrow(InvalidTransitionError);
  });

  it("throws when transitioning an unknown slug", () => {
    expect(() => transitionTask("ghost", "ready", root)).toThrow(TaskNotFoundError);
  });

  it("lists tasks newest-first", () => {
    createTask({ slug: "a", title: "A" }, root);
    createTask({ slug: "b", title: "B" }, root);
    const tasks = listTasks(root);
    expect(tasks.map((t) => t.slug)).toEqual(["b", "a"]);
  });

  it("updates updated_at on transition", () => {
    createTask({ slug: "ts", title: "TS" }, root);
    const before = getTask("ts", root).updated_at;
    transitionTask("ts", "ready", root);
    const after = getTask("ts", root).updated_at;
    expect(after >= before).toBe(true);
  });

  it("increments retry count and stores the last failure", () => {
    createTask({ slug: "retry", title: "Retry" }, root);
    const t1 = incrementRetryCount("retry", "tests failed", root);
    expect(t1.retry_count).toBe(1);
    expect(t1.last_failure).toBe("tests failed");

    const t2 = incrementRetryCount("retry", "lint errors", root);
    expect(t2.retry_count).toBe(2);
    expect(t2.last_failure).toBe("lint errors");

    expect(getTask("retry", root).retry_count).toBe(2);
  });

  it("sets the last failure without changing the retry count", () => {
    createTask({ slug: "set-fail", title: "Set Fail" }, root);
    incrementRetryCount("set-fail", "first", root);
    const t = setLastFailure("set-fail", "cap reached", root);
    expect(t.retry_count).toBe(1);
    expect(t.last_failure).toBe("cap reached");
  });

  it("clears retry state", () => {
    createTask({ slug: "clear", title: "Clear" }, root);
    incrementRetryCount("clear", "oops", root);
    const t = clearRetryState("clear", root);
    expect(t.retry_count).toBe(0);
    expect(t.last_failure).toBeNull();
  });

  describe("escape-hatch transitions (Slice 10)", () => {
    it("allows building -> ready", () => {
      createTask({ slug: "requeue", title: "Requeue" }, root);
      transitionTask("requeue", "ready", root);
      transitionTask("requeue", "building", root);
      transitionTask("requeue", "ready", root);
      expect(getTask("requeue", root).status).toBe("ready");
    });

    it("allows building -> backlog", () => {
      createTask({ slug: "to-authoring", title: "Authoring" }, root);
      transitionTask("to-authoring", "ready", root);
      transitionTask("to-authoring", "building", root);
      transitionTask("to-authoring", "backlog", root);
      expect(getTask("to-authoring", root).status).toBe("backlog");
    });

    it("allows validating -> backlog", () => {
      createTask({ slug: "v-back", title: "V Back" }, root);
      transitionTask("v-back", "ready", root);
      transitionTask("v-back", "building", root);
      transitionTask("v-back", "validating", root);
      transitionTask("v-back", "backlog", root);
      expect(getTask("v-back", root).status).toBe("backlog");
    });

    it("resets retry_count and last_failure on building -> ready", () => {
      createTask({ slug: "reset-ready", title: "Reset" }, root);
      transitionTask("reset-ready", "ready", root);
      transitionTask("reset-ready", "building", root);
      transitionTask("reset-ready", "validating", root);
      incrementRetryCount("reset-ready", "tests red", root);
      transitionTask("reset-ready", "building", root);
      expect(getTask("reset-ready", root).retry_count).toBe(1);
      expect(getTask("reset-ready", root).last_failure).toBe("tests red");

      transitionTask("reset-ready", "ready", root);
      const after = getTask("reset-ready", root);
      expect(after.status).toBe("ready");
      expect(after.retry_count).toBe(0);
      expect(after.last_failure).toBeNull();
    });

    it("resets retry_count and last_failure on building -> backlog", () => {
      createTask({ slug: "reset-back", title: "Reset Back" }, root);
      transitionTask("reset-back", "ready", root);
      transitionTask("reset-back", "building", root);
      transitionTask("reset-back", "validating", root);
      incrementRetryCount("reset-back", "lint", root);
      transitionTask("reset-back", "building", root);
      expect(getTask("reset-back", root).retry_count).toBe(1);

      transitionTask("reset-back", "backlog", root);
      const after = getTask("reset-back", root);
      expect(after.status).toBe("backlog");
      expect(after.retry_count).toBe(0);
      expect(after.last_failure).toBeNull();
    });

    it("resets retry_count and last_failure on validating -> backlog", () => {
      createTask({ slug: "reset-vback", title: "Reset VBack" }, root);
      transitionTask("reset-vback", "ready", root);
      transitionTask("reset-vback", "building", root);
      transitionTask("reset-vback", "validating", root);
      incrementRetryCount("reset-vback", "gate fail", root);
      expect(getTask("reset-vback", root).retry_count).toBe(1);
      expect(getTask("reset-vback", root).last_failure).toBe("gate fail");

      transitionTask("reset-vback", "backlog", root);
      const after = getTask("reset-vback", root);
      expect(after.status).toBe("backlog");
      expect(after.retry_count).toBe(0);
      expect(after.last_failure).toBeNull();
    });

    it("does not reset retry state on the automated validating -> building retry", () => {
      createTask({ slug: "auto-retry", title: "Auto" }, root);
      transitionTask("auto-retry", "ready", root);
      transitionTask("auto-retry", "building", root);
      transitionTask("auto-retry", "validating", root);
      incrementRetryCount("auto-retry", "fail", root);
      transitionTask("auto-retry", "building", root);
      const after = getTask("auto-retry", root);
      expect(after.status).toBe("building");
      expect(after.retry_count).toBe(1);
      expect(after.last_failure).toBe("fail");
    });

    it("does not reset last_failure on validating -> review (cap escalation)", () => {
      createTask({ slug: "cap", title: "Cap" }, root);
      transitionTask("cap", "ready", root);
      transitionTask("cap", "building", root);
      transitionTask("cap", "validating", root);
      setLastFailure("cap", "cap reached", root);
      transitionTask("cap", "review", root);
      const after = getTask("cap", root);
      expect(after.status).toBe("review");
      expect(after.last_failure).toBe("cap reached");
    });
  });
});
