import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Agent } from "../agent/types.js";
import { createInstallation, finishInstallation, setAgentReadiness } from "../agents/store.js";
import { registerRepository } from "../repositories/store.js";
import { buildApp } from "./http.js";

const testAgent: Agent = {
  async spawn(cwd, agentId) {
    return { cwd, agentId, name: "test", recordId: "test-session" };
  },
  async *prompt() {
    yield { type: "done", stopReason: "end_turn" };
  },
  async cancel() {},
  async close() {},
};

const configurableAgent: Agent = {
  async spawn(cwd, agentId) {
    return {
      cwd,
      agentId,
      name: "configurable",
      recordId: "configurable-session",
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "sonnet",
          options: [
            { value: "sonnet", name: "Sonnet" },
            { value: "opus", name: "Opus" },
          ],
        },
        { id: "fast", name: "Fast mode", type: "boolean", currentValue: false },
      ],
      modes: {
        currentModeId: "code",
        availableModes: [
          { id: "code", name: "Code" },
          { id: "plan", name: "Plan" },
        ],
      },
    };
  },
  async setConfigOption(session, configId, value) {
    session.configOptions = (session.configOptions ?? []).map((option) =>
      option.id === configId ? ({ ...option, currentValue: value } as typeof option) : option,
    );
    return session.configOptions;
  },
  async setMode(session, modeId) {
    session.modes = session.modes ? { ...session.modes, currentModeId: modeId } : null;
    return session.modes;
  },
  async *prompt() {
    yield { type: "done", stopReason: "end_turn" };
  },
  async cancel() {},
  async close() {},
};

function initGitRepo(root: string): void {
  execSync("git init -b main", { cwd: root, stdio: "ignore" });
  execSync("git config user.email test@example.com", { cwd: root, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: root, stdio: "ignore" });
  writeFileSync(join(root, "README.md"), "# Test\n");
  execSync("git add README.md && git commit -m init", { cwd: root, stdio: "ignore" });
}

async function req(app: ReturnType<typeof buildApp>, method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe("chat session API", () => {
  it("returns an empty session list before a repository is selected", async () => {
    const machineDir = mkdtempSync(join(tmpdir(), "marshal-chat-machine-"));
    const app = buildApp("0.0.1", { machineDir });

    expect((await req(app, "GET", "/api/threads")).status).toBe(409);
  });

  it("creates, opens, updates, and appends to a thread without starting an agent", async () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-chat-api-"));
    initGitRepo(root);
    const app = buildApp("0.0.1", { root, chatAgent: testAgent });
    const created = await req(app, "POST", "/api/threads", {
      agent_id: "agent-a",
      agent_version: "1.0.0",
      title: "Debug login",
    });
    expect(created.status).toBe(201);
    const id = created.body.thread.id;
    const repositoryId = created.body.thread.repository_id;
    expect(created.body.thread).toMatchObject({
      agent_id: "agent-a",
      agent_version: "1.0.0",
      title: "Debug login",
      status: "active",
    });

    const scratch = await req(app, "PATCH", `/api/threads/${id}?repository_id=${repositoryId}`, {
      scratch_markdown: "## Working draft",
    });
    expect(scratch.body.thread.scratch_markdown).toBe("## Working draft");

    const message = await req(app, "POST", `/api/threads/${id}/messages?repository_id=${repositoryId}`, {
      role: "user",
      content: "Please inspect this.",
    });
    expect(message.status).toBe(201);
    expect(message.body.message).toMatchObject({
      thread_id: id,
      role: "user",
      content: "Please inspect this.",
    });

    const updated = await req(app, "PATCH", `/api/threads/${id}?repository_id=${repositoryId}`, {
      pinned: true,
      status: "closed",
    });
    expect(updated.status).toBe(200);
    expect(updated.body.thread).toMatchObject({ id, pinned: true, status: "closed" });

    const detail = await req(app, "GET", `/api/threads/${id}?repository_id=${repositoryId}`);
    expect(detail.body.messages).toHaveLength(1);
  });

  it("requires the requested repository scope and rejects cross-repository thread access", async () => {
    const firstRoot = mkdtempSync(join(tmpdir(), "marshal-chat-api-first-"));
    const secondRoot = mkdtempSync(join(tmpdir(), "marshal-chat-api-second-"));
    initGitRepo(firstRoot);
    initGitRepo(secondRoot);
    const machineDir = mkdtempSync(join(tmpdir(), "marshal-chat-api-machine-"));
    const first = registerRepository(firstRoot, machineDir);
    const second = registerRepository(secondRoot, machineDir);
    const app = buildApp("0.0.1", { root: firstRoot, machineDir, chatAgent: testAgent });

    const created = await req(app, "POST", "/api/threads", {
      repository_id: first.id,
      agent_id: "agent-a",
      agent_version: "1.0.0",
    });
    expect(created.status).toBe(201);
    const threadId = created.body.thread.id;

    expect((await req(app, "GET", `/api/threads?repository_id=${second.id}`)).body.threads).toEqual([]);
    expect((await req(app, "GET", `/api/threads/${threadId}?repository_id=${second.id}`)).status).toBe(404);
    expect((await req(app, "POST", `/api/threads/${threadId}/messages?repository_id=${second.id}`, {
      role: "user",
      content: "must not cross scope",
    })).status).toBe(404);
    expect((await req(app, "GET", `/api/threads/${threadId}`)).body.thread.repository_id).toBe(first.id);
    expect((await req(app, "GET", `/api/threads/${threadId}?repository_id=${first.id}`)).body.thread.repository_id).toBe(first.id);
  });

  it("rejects unknown session fields and missing agent IDs", async () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-chat-api-"));
    initGitRepo(root);
    const app = buildApp("0.0.1", { root, chatAgent: testAgent });
    expect((await req(app, "POST", "/api/threads", { title: "No agent" })).status).toBe(422);
    expect(
      (
        await req(app, "POST", "/api/threads", {
          agent_id: "a",
          agent_version: "1.0.0",
          nope: true,
        })
      ).status,
    ).toBe(400);
  });

  it("pins a ready installed agent version and rejects unready production selections", async () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-chat-api-"));
    initGitRepo(root);
    const machineDir = mkdtempSync(join(tmpdir(), "marshal-chat-machine-"));
    const input = {
      id: "agent-a",
      version: "1.2.3",
      source: "registry" as const,
      license: "MIT",
      distribution: "npx" as const,
      package_specifier: "agent-a@1.2.3",
      launch: { command: "npx" as const, args: ["--yes", "agent-a@1.2.3"] },
      registry_snapshot_fetched_at: "fixture",
      integrity_status: "not_applicable" as const,
      status: "installing" as const,
      readiness_status: "unknown" as const,
      readiness_error: null,
      protocol_version: null,
      capabilities: null,
      auth_methods: [],
      raw_initialize: null,
      probed_at: null,
    };
    const operation = createInstallation(input, "install-op", machineDir);
    finishInstallation(operation.id, "installed", null, machineDir);
    const app = buildApp("0.0.1", { root, machineDir });
    const unready = await req(app, "POST", "/api/threads", {
      agent_id: input.id,
      agent_version: input.version,
    });
    expect(unready).toMatchObject({ status: 409, body: { code: "agent_not_ready" } });
    setAgentReadiness(
      input.id,
      input.version,
      {
        readiness_status: "ready",
        readiness_error: null,
        protocol_version: 1,
        capabilities: {
          prompt: { text: true, image: false, audio: false, embedded_context: false },
          session: { close: true, list: false, load: false, fork: false, resume: false },
          load_session: false,
          auth: { logout: false },
        },
        auth_methods: [],
        raw_initialize: {},
        probed_at: new Date().toISOString(),
      },
      machineDir,
    );
    const created = await req(app, "POST", "/api/threads", {
      agent_id: input.id,
      agent_version: input.version,
    });
    expect(created.body.thread).toMatchObject({ agent_id: input.id, agent_version: input.version });
    expect(created.body.thread.title).toBe("New session");
  });

  it("supports lifecycle actions and deletion", async () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-chat-api-"));
    initGitRepo(root);
    const app = buildApp("0.0.1", { root, chatAgent: testAgent });
    const created = await req(app, "POST", "/api/threads", {
      agent_id: "agent-a",
      agent_version: "1.0.0",
    });
    const id = created.body.thread.id;
    expect(
      (
        await req(app, "PATCH", `/api/threads/${id}`, {
          archived: true,
          pinned: true,
          status: "closed",
        })
      ).body.thread,
    ).toMatchObject({ archived: true, pinned: true, status: "closed" });
    const repositoryId = (await req(app, "GET", "/api/repositories")).body.repositories[0].id;
    expect((await req(app, "GET", `/api/threads?repository_id=${repositoryId}`)).body.threads).toHaveLength(0);
    expect((await req(app, "GET", `/api/threads?repository_id=${repositoryId}&archived=true`)).body.threads[0]).toMatchObject({
      id,
      archived: true,
    });
    expect((await req(app, "DELETE", `/api/threads/${id}`)).body).toEqual({ deleted: true });
    expect((await req(app, "GET", `/api/threads/${id}`)).status).toBe(404);
  });

  it("initializes and updates agent-owned session options", async () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-chat-config-"));
    initGitRepo(root);
    const app = buildApp("0.0.1", { root, chatAgent: configurableAgent });
    const created = await req(app, "POST", "/api/threads", {
      agent_id: "configurable",
      agent_version: "1.0.0",
    });
    const id = created.body.thread.id;

    const initialized = await req(app, "POST", `/api/threads/${id}/session`);
    expect(initialized.body.thread).toMatchObject({
      session_initialized: true,
      session_config_options: [
        expect.objectContaining({ id: "model", currentValue: "sonnet" }),
        expect.objectContaining({ id: "fast", currentValue: false }),
      ],
      session_modes: expect.objectContaining({ currentModeId: "code" }),
    });

    const model = await req(app, "POST", `/api/threads/${id}/session/config-options/model`, {
      value: "opus",
    });
    expect(model.body.thread.session_config_options).toContainEqual(
      expect.objectContaining({ id: "model", currentValue: "opus" }),
    );
    const fast = await req(app, "POST", `/api/threads/${id}/session/config-options/fast`, {
      value: true,
    });
    expect(fast.body.thread.session_config_options).toContainEqual(
      expect.objectContaining({ id: "fast", currentValue: true }),
    );
    const mode = await req(app, "POST", `/api/threads/${id}/session/mode`, { mode_id: "plan" });
    expect(mode.body.thread.session_modes.currentModeId).toBe("plan");
  });
});
