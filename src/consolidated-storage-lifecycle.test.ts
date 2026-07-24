import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { openDatabase } from "./db/index.js";
import { registerRepository, removeRepository, reconnectRepository, selectRepository, getSelectedRepository } from "./repositories/store.js";
import { createInstallation, finishInstallation, getInstalledAgent } from "./agents/store.js";
import { bindAgentCredential, resolveAgentCredentialValues } from "./agents/credentials.js";
import { createChatAttachment } from "./chat/attachments.js";
import { createChatThread } from "./chat/store.js";
import { createTask, getTask } from "./tasks/store.js";
import { WorktreeManager } from "./worktree/manager.js";
import { buildApp } from "./daemon/http.js";
import { reconcileWorktrees } from "./worktree/manager.js";

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

function gitRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "marshal-lifecycle-checkout-"));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
  writeFileSync(join(root, "README.md"), "# lifecycle\n");
  execFileSync("git", ["-C", root, "add", "README.md"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "init"]);
  return root;
}

describe("consolidated storage lifecycle", () => {
  it("keeps the complete custom-home lifecycle outside the checkout", () => {
    const home = mkdtempSync(join(tmpdir(), "marshal-lifecycle-home-"));
    const checkout = gitRepository();
    const repository = registerRepository(checkout, home);
    selectRepository(repository.id, home);

    const db = openDatabase(home);
    expect(db.prepare("SELECT COUNT(*) AS count FROM __drizzle_migrations").get()).toEqual({ count: 5 });
    expect(readdirSync(home).filter((name) => name === "marshal.db")).toHaveLength(1);
    expect(existsSync(join(home, "machine.db"))).toBe(false);
    expect(existsSync(join(home, "state.db"))).toBe(false);
    expect(readdirSync(home).filter((name) => !/^marshal\.db-(wal|shm)$/.test(name)).sort()).toEqual(["agents", "credentials", "logs", "marshal.db", "registry", "repositories", "tmp"]);

    const operation = createInstallation({
      id: "lifecycle-agent",
      version: "1.0.0",
      source: "custom",
      license: "MIT",
      distribution: "binary",
      package_specifier: null,
      launch: { command: process.execPath, args: ["-e", ""] },
      registry_snapshot_fetched_at: "custom",
      integrity_status: "not_applicable",
      status: "installing",
      readiness_status: "unknown",
      readiness_error: null,
      protocol_version: null,
      capabilities: null,
      auth_methods: [],
      raw_initialize: null,
      probed_at: null,
    }, "lifecycle-install", home);
    finishInstallation(operation.id, "installed", null, home);
    const installed = getInstalledAgent("lifecycle-agent", "1.0.0", home)!;
    bindAgentCredential(installed.installation_id, "TOKEN", "secret", true, home);
    expect(resolveAgentCredentialValues(installed.installation_id, home)).toEqual({ TOKEN: "secret" });

    const thread = createChatThread(repository.id, { agentId: installed.id, agentVersion: installed.version }, home);
    createChatAttachment(repository.id, thread.id, { type: "image/png", name: "proof.png", size: png.length, bytes: png }, home);
    const task = createTask({ repositoryId: repository.id, slug: "lifecycle-task", title: "Lifecycle task" }, home);
    const worktree = new WorktreeManager(repository.id, checkout, { machineDir: home }).create(task.slug);
    expect(worktree.path).toContain(join(home, "repositories", repository.id, "worktrees"));
    expect(existsSync(join(checkout, ".marshal"))).toBe(false);

    // A fresh manager is the restart/recovery boundary for durable worktrees.
    expect(new WorktreeManager(repository.id, checkout, { machineDir: home }).create(task.slug).id).toBe(worktree.id);
    const worktreeRow = db.prepare("SELECT status FROM worktrees WHERE id = ?").get(worktree.id) as { status: string };
    expect(worktreeRow.status).toBe("ready");
    rmSync(checkout, { recursive: true, force: true });
    reconcileWorktrees(home);
    expect(db.prepare("SELECT id FROM worktrees WHERE id = ?").get(worktree.id)).toBeTruthy();
    removeRepository(repository.id, home);
    expect(getSelectedRepository(home)).toBeUndefined();
    expect(getTask(repository.id, task.slug, home).title).toBe("Lifecycle task");
    expect(() => selectRepository(repository.id, home)).toThrow(/unregistered/);

    const reconnected = gitRepository();
    expect(reconnectRepository(repository.id, reconnected, home).id).toBe(repository.id);
    expect(getTask(repository.id, task.slug, home).title).toBe("Lifecycle task");
    expect(existsSync(join(home, "repositories", repository.id))).toBe(true);
  });

  it("proves the daemon HTTP boundary with a fake ACP client and retained files", async () => {
    const home = mkdtempSync(join(tmpdir(), "marshal-api-home-"));
    const checkout = gitRepository();
    const repository = registerRepository(checkout, home);
    const app = buildApp("0.0.1", { machineDir: home, chatAgent: {
      async spawn(cwd, agentId) { return { cwd, agentId, name: "fixture", recordId: "fixture-session" }; },
      async *prompt() { yield { type: "done", stopReason: "end_turn" }; },
      async cancel() {},
      async close() {},
    } });
    expect((await app.request(`/api/repositories/${repository.id}/select`, { method: "POST" })).status).toBe(200);

    const operation = createInstallation({
      id: "api-fixture-agent", version: "1.0.0", source: "custom", license: "MIT", distribution: "binary",
      package_specifier: null, launch: { command: process.execPath, args: ["-e", ""] },
      registry_snapshot_fetched_at: "fixture", integrity_status: "not_applicable", status: "installing",
      readiness_status: "unknown", readiness_error: null, protocol_version: null, capabilities: null,
      auth_methods: [], raw_initialize: null, probed_at: null,
    }, "api-fixture-install", home);
    finishInstallation(operation.id, "installed", null, home);
    expect((await app.request("/api/agents")).status).toBe(200);

    const threadResponse = await app.request("/api/threads", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repository_id: repository.id, agent_id: "api-fixture-agent", agent_version: "1.0.0" }),
    });
    expect(threadResponse.status).toBe(201);
    const thread = (await threadResponse.json() as { thread: { id: string } }).thread;
    const upload = new FormData();
    upload.append("file", new File([png], "proof.png", { type: "image/png" }));
    expect((await app.request(`/api/threads/${thread.id}/attachments?repository_id=${repository.id}`, { method: "POST", body: upload })).status).toBe(201);

    const taskResponse = await app.request(`/api/tasks?repository_id=${repository.id}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "API lifecycle" }),
    });
    expect(taskResponse.status).toBe(201);
    const task = (await taskResponse.json() as { task: { slug: string } }).task;
    const readyResponse = await app.request(`/api/tasks/${task.slug}/ready?repository_id=${repository.id}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ specMarkdown: "## Goal\nfixture\n" }),
    });
    expect(readyResponse.status).toBe(200);
    const namespace = join(home, "repositories", repository.id);
    expect(statSync(join(namespace, "attachments")).isDirectory()).toBe(true);
    expect(statSync(join(namespace, "worktrees")).isDirectory()).toBe(true);
    expect(existsSync(join(checkout, ".marshal"))).toBe(false);
  });
});
