import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { registerRepository } from "./repositories/store.js";
import { createTask, getTask, listTasks, transitionTask } from "./tasks/store.js";
import { generateUniqueSlug } from "./tasks/slug.js";
import { RunLog } from "./daemon/run-log.js";

function repository(machineDir: string) {
  return registerRepository(mkdtempSync(join(tmpdir(), "marshal-factory-repo-")), machineDir);
}

describe("factory repository ownership", () => {
  it("allows duplicate slugs while keeping task lookups and runs isolated", () => {
    const machineDir = mkdtempSync(join(tmpdir(), "marshal-factory-machine-"));
    const first = repository(machineDir);
    const second = repository(machineDir);
    const slug = generateUniqueSlug(first.id, "Same task", machineDir);
    createTask({ repositoryId: first.id, slug, title: "First" }, machineDir);
    createTask({ repositoryId: second.id, slug, title: "Second" }, machineDir);
    expect(getTask(first.id, slug, machineDir).title).toBe("First");
    expect(getTask(second.id, slug, machineDir).title).toBe("Second");
    expect(listTasks(first.id, machineDir)).toHaveLength(1);
    expect(listTasks(second.id, machineDir)).toHaveLength(1);
    const run = new RunLog(first.id, machineDir).startRun(getTask(first.id, slug, machineDir).id, "builder", "agent", "prompt");
    expect(new RunLog(second.id, machineDir).getRun(run)).toBeUndefined();
  });

  it("rejects cross-repository task transitions", () => {
    const machineDir = mkdtempSync(join(tmpdir(), "marshal-factory-machine-"));
    const first = repository(machineDir);
    const second = repository(machineDir);
    createTask({ repositoryId: first.id, slug: "owned", title: "Owned" }, machineDir);
    expect(() => transitionTask(second.id, "owned", "ready", machineDir)).toThrow("Task not found");
    expect(getTask(first.id, "owned", machineDir).status).toBe("backlog");
  });
});
