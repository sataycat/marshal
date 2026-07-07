import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { InvalidTransitionError } from "./state-machine.js";
import {
  createTask,
  DuplicateSlugError,
  getTask,
  listTasks,
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
});
