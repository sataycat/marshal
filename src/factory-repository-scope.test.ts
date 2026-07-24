import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { registerRepository } from "./repositories/store.js";
import { createTask, getTask, listTasks, transitionTask } from "./tasks/store.js";
import { generateUniqueSlug } from "./tasks/slug.js";
import { RunLog } from "./daemon/run-log.js";
import { appendSpecMessage, listSpecMessages } from "./tasks/spec-store.js";
import { saveWorkflowProfile, type WorkflowProfileInput } from "./workflows/store.js";
import { EventBus } from "./daemon/bus.js";
import { runOnce } from "./daemon/orchestrator.js";
import { buildApp } from "./daemon/http.js";

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

  it("keeps spec messages, profiles, runs, and scheduler choices isolated by repository ID", async () => {
    const machineDir = mkdtempSync(join(tmpdir(), "marshal-factory-acceptance-"));
    const first = repository(machineDir);
    const second = repository(machineDir);
    const slug = "same-slug";
    const firstTask = createTask({ repositoryId: first.id, slug, title: "First", specMarkdown: "spec" }, machineDir);
    const secondTask = createTask({ repositoryId: second.id, slug, title: "Second", specMarkdown: "spec" }, machineDir);
    appendSpecMessage(first.id, slug, "user", "first message", machineDir);
    appendSpecMessage(second.id, slug, "user", "second message", machineDir);
    expect(listSpecMessages(first.id, slug, machineDir).map((message) => message.content)).toEqual(["first message"]);
    expect(listSpecMessages(second.id, slug, machineDir).map((message) => message.content)).toEqual(["second message"]);

    const profileInput: WorkflowProfileInput = {
      name: "Profile",
      permission_policy: "allow_reads_ask_writes",
      unattended_authorized: false,
      timeout_ms: 1000,
      max_retries: 0,
      verification_commands: [],
      require_decorrelated_builder_validator: false,
      assignments: [],
    };
    const firstProfile = saveWorkflowProfile(first.id, profileInput, undefined, machineDir);
    expect(saveWorkflowProfile(second.id, profileInput, undefined, machineDir).repository_id).toBe(second.id);
    expect(() => saveWorkflowProfile(first.id, profileInput, firstProfile.id, machineDir)).not.toThrow();

    transitionTask(first.id, slug, "ready", machineDir);
    transitionTask(second.id, slug, "ready", machineDir);
    const firstRun = new RunLog(first.id, machineDir).startRun(firstTask.id, "builder", "agent", "first");
    const secondRun = new RunLog(second.id, machineDir).startRun(secondTask.id, "builder", "agent", "second");
    expect(new RunLog(first.id, machineDir).getRun(secondRun)).toBeUndefined();
    expect(new RunLog(second.id, machineDir).getRun(firstRun)).toBeUndefined();
    const schedulerManager = { create: () => ({ path: machineDir }) } as never;
    expect(await runOnce({ repositoryId: first.id, machineDir, manager: schedulerManager })).toMatchObject({ slug, status: "skipped" });
  });

  it("preserves repository IDs through factory HTTP lookups and rejects foreign mutations", async () => {
    const machineDir = mkdtempSync(join(tmpdir(), "marshal-factory-http-"));
    const first = repository(machineDir);
    const second = repository(machineDir);
    const app = buildApp("0.0.1", { machineDir });
    const create = async (repositoryId: string, title: string) => {
      const response = await app.request(`/api/tasks?repository_id=${repositoryId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      });
      return (await response.json()) as { task: { slug: string; repository_id: string } };
    };
    const firstTask = await create(first.id, "Same slug");
    const secondTask = await create(second.id, "Same slug");
    const firstOnly = await create(first.id, "First only");
    expect(firstTask.task.slug).toBe(secondTask.task.slug);
    expect(firstTask.task.repository_id).toBe(first.id);
    expect(secondTask.task.repository_id).toBe(second.id);

    const firstDetail = await app.request(`/api/tasks/${firstTask.task.slug}?repository_id=${first.id}`);
    expect(firstDetail.status).toBe(200);
    expect(((await firstDetail.json()) as { task: { repository_id: string } }).task.repository_id).toBe(first.id);
    const foreignTransition = await app.request(`/api/tasks/${firstOnly.task.slug}/transition?repository_id=${second.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "ready" }),
    });
    expect(foreignTransition.status).toBe(404);

    const firstProfiles = await app.request(`/api/repositories/${first.id}/workflow-profiles`);
    const secondProfiles = await app.request(`/api/repositories/${second.id}/workflow-profiles`);
    expect(((await firstProfiles.json()) as { profiles: unknown[] }).profiles).toEqual([]);
    expect(((await secondProfiles.json()) as { profiles: unknown[] }).profiles).toEqual([]);
  });
});
