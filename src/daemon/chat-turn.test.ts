import { execSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Agent, AgentEvent, AgentSession } from "../agent/types.js";
import { EventBus } from "./bus.js";
import { buildApp } from "./http.js";
import { createInstallation, finishInstallation, setAgentReadiness } from "../agents/store.js";
import { RequestError } from "@agentclientprotocol/sdk";

class FakeAgent implements Agent {
  spawnCount = 0;
  prompts: string[] = [];

  async spawn(cwd: string, agentId: string): Promise<AgentSession> {
    this.spawnCount += 1;
    return { cwd, agentId, name: "fake", recordId: "session-1" };
  }

  async *prompt(_session: AgentSession, text: string): AsyncIterable<AgentEvent> {
    this.prompts.push(text);
    yield { type: "thinking", text: "planning" };
    yield { type: "text", text: "hello " };
    yield { type: "text", text: "from ACP" };
    yield { type: "done", stopReason: "end_turn" };
  }

  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
}

class ImageAgent implements Agent {
  prompts: unknown[] = [];
  async spawn(cwd: string, agentId: string): Promise<AgentSession> { return { cwd, agentId, name: "image-fake", recordId: "image-session", supportsImages: true }; }
  async *prompt(_session: AgentSession, prompt: unknown): AsyncIterable<AgentEvent> { this.prompts.push(prompt); yield { type: "text", text: "saw image" }; yield { type: "done", stopReason: "end_turn" }; }
  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
}

class PermissionAgent implements Agent {
  async spawn(cwd: string, agentId: string): Promise<AgentSession> {
    return { cwd, agentId, name: "permission-fake", recordId: "permission-session" };
  }

  async *prompt(_session: AgentSession, _text: string, opts?: { onPermission?: (request: any) => Promise<string | undefined> }): AsyncIterable<AgentEvent> {
    const optionId = await opts?.onPermission?.({
      requestId: "permission-request",
      sessionId: "permission-session",
      tool: "Execute command",
      kind: "execute",
      options: [
        { optionId: "reject", name: "Reject", kind: "reject_once" },
        { optionId: "allow", name: "Allow", kind: "allow_once" },
      ],
    });
    yield { type: "permission", tool: "Execute command", granted: optionId === "allow", requestId: "permission-request" };
    if (optionId !== "allow") {
      yield { type: "error", message: "permission denied" };
      return;
    }
    yield { type: "text", text: "continued" };
    yield { type: "done", stopReason: "end_turn" };
  }

  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
}

class RecoveringAuthAgent implements Agent {
  spawnCount = 0; promptCount = 0; closeCount = 0; authenticated = false;
  async spawn(cwd: string, agentId: string): Promise<AgentSession> { this.spawnCount += 1; return { cwd, agentId, name: `auth-${this.spawnCount}`, recordId: `auth-${this.spawnCount}` }; }
  async *prompt(): AsyncIterable<AgentEvent> { this.promptCount += 1; if (!this.authenticated) { const failure = { kind: "authentication_required" as const, message: "Sign in required", protocol_code: RequestError.authRequired().code, data: { methodId: "login" } }; yield { type: "error", message: failure.message, code: failure.protocol_code, failure }; return; } yield { type: "text", text: "recovered" }; yield { type: "done", stopReason: "end_turn" }; }
  async cancel(): Promise<void> {}
  async close(): Promise<void> { this.closeCount += 1; }
}

function initGitRepo(root: string): void {
  execSync("git init -b main", { cwd: root, stdio: "ignore" });
  execSync("git config user.email test@example.com", { cwd: root, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: root, stdio: "ignore" });
  writeFileSync(join(root, "README.md"), "# Test\n");
  execSync("git add README.md && git commit -m init", { cwd: root, stdio: "ignore" });
}

function installReadyUvxAgent(machineDir: string): void {
  const operation = createInstallation({ id: "uv-agent", version: "1.2.3", source: "registry", license: "MIT", distribution: "uvx", package_specifier: "uv-agent==1.2.3", launch: { command: "uvx", args: ["--from", "uv-agent==1.2.3", "uv-agent", "acp"] }, registry_snapshot_fetched_at: "fixture", integrity_status: "not_applicable", status: "installing", readiness_status: "unknown", readiness_error: null, protocol_version: null, capabilities: null, auth_methods: [], raw_initialize: null, probed_at: null }, "uv-install", machineDir);
  finishInstallation(operation.id, "installed", null, machineDir);
  setAgentReadiness("uv-agent", "1.2.3", { readiness_status: "ready", readiness_error: null, protocol_version: 1, capabilities: { prompt: { text: true, image: false, audio: false, embedded_context: false }, session: { close: true, list: false, load: false, fork: false, resume: false }, load_session: false, auth: { logout: false } }, auth_methods: [], raw_initialize: {}, probed_at: new Date().toISOString() }, machineDir);
}

function writeUvxShim(binDir: string): void {
  const shim = `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
let sessionId = "uvx-session";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, agentCapabilities: { sessionCapabilities: { close: {} } } } });
  else if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
  else if (message.method === "session/prompt") { send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } }); }
  else if (message.method === "session/close") send({ jsonrpc: "2.0", id: message.id, result: {} });
});
`;
  const path = join(binDir, "uvx");
  writeFileSync(path, shim, { mode: 0o755 });
  chmodSync(path, 0o755);
}

async function req(app: ReturnType<typeof buildApp>, method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
}

describe("chat turns", () => {
  it("forwards uploaded attachment parts to an image-capable agent", async () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-chat-image-"));
    initGitRepo(root);
    const agent = new ImageAgent();
    const app = buildApp("0.0.1", { root, bus: new EventBus(), chatAgent: agent });
    const created = await req(app, "POST", "/api/threads", { agent_id: "fake", agent_version: "test" });
    const id = created.body.thread.id;
    const repositoryId = created.body.thread.repository_id;
    const upload = new FormData();
    upload.append("file", new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "shot.png", { type: "image/png" }));
    const uploadRes = await app.request(`/api/threads/${id}/attachments?repository_id=${repositoryId}`, { method: "POST", body: upload });
    if (!uploadRes.ok) throw new Error(`upload failed ${uploadRes.status}: ${await uploadRes.text()}`);
    const attachment = (await uploadRes.json() as any).attachment;
    const result = await req(app, "POST", `/api/threads/${id}/send?repository_id=${repositoryId}`, { content: "Inspect screenshot", attachment_ids: [attachment.id] });
    expect(result.status).toBe(201);
    expect(agent.prompts[0]).toEqual([{ type: "text", text: "Inspect screenshot" }, { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]);
    expect(result.body.userMessage.attachment_ids).toEqual([attachment.id]);
  });
  it("streams a turn, persists the transcript, and reuses the ACP session", async () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-chat-turn-"));
    initGitRepo(root);
    const agent = new FakeAgent();
    const bus = new EventBus();
    const events: string[] = [];
    bus.subscribe((event) => events.push(event.type));
    const app = buildApp("0.0.1", { root, bus, chatAgent: agent });
    const created = await req(app, "POST", "/api/threads", { agent_id: "fake", agent_version: "test" });
    const id = created.body.thread.id;

    const first = await req(app, "POST", `/api/threads/${id}/send`, { content: "Hello" });
    expect(first.status).toBe(201);
    expect(first.body.assistantMessage.content).toBe("hello from ACP");
    expect(events).toContain("thread.event");

    await req(app, "POST", `/api/threads/${id}/send`, { content: "Again" });
    const detail = await req(app, "GET", `/api/threads/${id}`);
    expect(agent.spawnCount).toBe(1);
    expect(agent.prompts).toEqual(["Hello", "Again"]);
    expect(detail.body.messages.map((message: { role: string; content: string }) => [message.role, message.content])).toEqual([
      ["user", "Hello"],
      ["assistant", "hello from ACP"],
      ["user", "Again"],
      ["assistant", "hello from ACP"],
    ]);
    expect(detail.body.thread.status).toBe("active");
  });

  it("uses a ready uvx installation for a repository thread", async () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-chat-uvx-"));
    const machineDir = mkdtempSync(join(tmpdir(), "marshal-chat-uvx-machine-"));
    const binDir = mkdtempSync(join(tmpdir(), "marshal-chat-uvx-bin-"));
    writeUvxShim(binDir);
    installReadyUvxAgent(machineDir);
    initGitRepo(root);
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    try {
      const app = buildApp("0.0.1", { root, machineDir, bus: new EventBus() });
      const created = await req(app, "POST", "/api/threads", { agent_id: "uv-agent", agent_version: "1.2.3" });
      expect(created.status).toBe(201);
      const result = await req(app, "POST", `/api/threads/${created.body.thread.id}/send`, { content: "Use uvx" });
      expect(result.status).toBe(201);
      expect(result.body.assistantMessage).toBeDefined();
      const detail = await req(app, "GET", `/api/threads/${created.body.thread.id}`);
      expect(detail.body.thread).toMatchObject({ agent_id: "uv-agent", agent_version: "1.2.3", status: "active" });
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("pauses an interactive turn until the browser decides and fails denied turns", async () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-chat-permission-"));
    initGitRepo(root);
    const app = buildApp("0.0.1", { root, bus: new EventBus(), chatAgent: new PermissionAgent() });
    const created = await req(app, "POST", "/api/threads", { agent_id: "fake", agent_version: "test" });
    const id = created.body.thread.id;
    const sending = req(app, "POST", `/api/threads/${id}/send`, { content: "Run it" });
    let pending: any;
    for (let i = 0; i < 20; i += 1) {
      pending = (await req(app, "GET", `/api/threads/${id}/permissions`)).body.permissions[0];
      if (pending) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(pending).toMatchObject({ requestId: "permission-request", tool: "Execute command" });
    expect((await req(app, "POST", `/api/threads/${id}/permissions/${pending.requestId}`, { action: "approve" })).status).toBe(200);
    expect((await sending).body.assistantMessage.content).toBe("continued");
    expect((await req(app, "POST", `/api/threads/${id}/permissions/unknown`, { action: "approve" })).status).toBe(409);
  });
  it("preserves typed AuthRequired prompts and only replays through explicit resubmit on a replacement session", async () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-chat-auth-recovery-")); initGitRepo(root);
    const agent = new RecoveringAuthAgent(); const app = buildApp("0.0.1", { root, bus: new EventBus(), chatAgent: agent });
    const created = await req(app, "POST", "/api/threads", { agent_id: "fake", agent_version: "test" }); const id = created.body.thread.id;
    const failed = await req(app, "POST", `/api/threads/${id}/send`, { content: "exact prompt" });
    expect(failed).toMatchObject({ status: 409, body: { error: "Sign in required", code: "authentication_required", failure: { kind: "authentication_required", protocol_code: RequestError.authRequired().code, message: "Sign in required", data: { methodId: "login" } } } });
    const detail = await req(app, "GET", `/api/threads/${id}`);
    expect(detail.body.thread).toMatchObject({ status: "authentication_required", failure: { kind: "authentication_required", protocol_code: RequestError.authRequired().code } });
    expect(detail.body.messages[0]).toMatchObject({ content: "exact prompt", prompt_status: "authentication_required" });
    expect(agent.promptCount).toBe(1); expect(agent.closeCount).toBe(1);
    agent.authenticated = true;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(agent.promptCount).toBe(1);
    const replay = await req(app, "POST", `/api/threads/${id}/messages/${detail.body.messages[0].id}/resubmit`);
    expect(replay.status).toBe(201); expect(replay.body.assistantMessage.content).toBe("recovered");
    expect(agent.spawnCount).toBe(2); expect(agent.promptCount).toBe(2);
  });
  it("does not reinterpret an ordinary auth-like message as AuthRequired", async () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-chat-generic-auth-error-")); initGitRepo(root);
    const agent: Agent = { async spawn(cwd, agentId) { return { cwd, agentId, name: "generic" }; }, async *prompt() { yield { type: "error", message: "please run /login" }; }, async cancel() {}, async close() {} };
    const app = buildApp("0.0.1", { root, bus: new EventBus(), chatAgent: agent }); const created = await req(app, "POST", "/api/threads", { agent_id: "fake", agent_version: "test" });
    const failed = await req(app, "POST", `/api/threads/${created.body.thread.id}/send`, { content: "hello" }); const detail = await req(app, "GET", `/api/threads/${created.body.thread.id}`);
    expect(failed).toEqual({ status: 500, body: { error: "Internal server error", code: "internal_error" } });
    expect(detail.body.thread.status).toBe("error"); expect(detail.body.thread.failure.kind).toBe("agent_internal_error"); expect(detail.body.messages[0].prompt_status).toBeNull();
  });
  it("maps typed AuthRequired during session creation without losing ACP metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-chat-session-auth-")); initGitRepo(root);
    const failure = { kind: "authentication_required" as const, message: "Choose an account", protocol_code: RequestError.authRequired().code, data: { methodId: "browser", reason: "expired" } };
    const agent: Agent = { async spawn() { throw RequestError.authRequired(failure.data, "Choose an account"); }, async *prompt() {}, async cancel() {}, async close() {} };
    const app = buildApp("0.0.1", { root, bus: new EventBus(), chatAgent: agent });
    const created = await req(app, "POST", "/api/threads", { agent_id: "fake", agent_version: "test" });
    const failed = await req(app, "POST", `/api/threads/${created.body.thread.id}/send`, { content: "hello" });
    expect(failed).toMatchObject({ status: 409, body: { code: "authentication_required", failure: { kind: "authentication_required", protocol_code: failure.protocol_code, data: failure.data } } });
    expect(failed.body.error).toContain("Choose an account");
  });
  it("preserves structured non-auth ACP errors at the HTTP boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-chat-protocol-error-")); initGitRepo(root);
    const failure = { kind: "agent_internal_error" as const, message: "Provider request failed", protocol_code: -32001, data: { requestId: "req-1", retryable: false } };
    const agent: Agent = { async spawn(cwd, agentId) { return { cwd, agentId, name: "protocol-error" }; }, async *prompt() { yield { type: "error", message: failure.message, code: failure.protocol_code, failure }; }, async cancel() {}, async close() {} };
    const app = buildApp("0.0.1", { root, bus: new EventBus(), chatAgent: agent });
    const created = await req(app, "POST", "/api/threads", { agent_id: "fake", agent_version: "test" });
    const failed = await req(app, "POST", `/api/threads/${created.body.thread.id}/send`, { content: "hello" });
    expect(failed).toEqual({ status: 502, body: { error: failure.message, code: failure.kind, failure } });
  });
});
