import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Agent } from "../agent/types.js";
import { createInstallation, finishInstallation, setAgentReadiness } from "../agents/store.js";
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

describe("chat thread API", () => {
  it("returns an empty thread list before a repository is selected", async () => {
    const machineDir = mkdtempSync(join(tmpdir(), "marshal-chat-machine-"));
    const app = buildApp("0.0.1", { machineDir });

    expect(await req(app, "GET", "/api/threads")).toEqual({ status: 200, body: { threads: [] } });
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
    expect(created.body.thread).toMatchObject({
      agent_id: "agent-a",
      agent_version: "1.0.0",
      title: "Debug login",
      status: "draft",
    });

    const scratch = await req(app, "PATCH", `/api/threads/${id}`, {
      scratch_markdown: "## Working draft",
    });
    expect(scratch.body.thread.scratch_markdown).toBe("## Working draft");

    const message = await req(app, "POST", `/api/threads/${id}/messages`, {
      role: "user",
      content: "Please inspect this.",
    });
    expect(message.status).toBe(201);
    expect(message.body.message).toMatchObject({
      thread_id: id,
      role: "user",
      content: "Please inspect this.",
    });

    const updated = await req(app, "PATCH", `/api/threads/${id}`, {
      pinned: true,
      status: "closed",
    });
    expect(updated.status).toBe(200);
    expect(updated.body.thread).toMatchObject({ id, pinned: true, status: "closed" });

    const detail = await req(app, "GET", `/api/threads/${id}`);
    expect(detail.body.messages).toHaveLength(1);
  });

  it("rejects unknown thread fields and missing agent IDs", async () => {
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
    expect((await req(app, "GET", "/api/threads")).body.threads).toHaveLength(0);
    expect((await req(app, "GET", "/api/threads?archived=true")).body.threads[0]).toMatchObject({
      id,
      archived: true,
    });
    expect((await req(app, "DELETE", `/api/threads/${id}`)).body).toEqual({ deleted: true });
    expect((await req(app, "GET", `/api/threads/${id}`)).status).toBe(404);
  });
});
