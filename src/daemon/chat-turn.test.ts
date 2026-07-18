import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Agent, AgentEvent, AgentSession } from "../agent/types.js";
import { EventBus } from "./bus.js";
import { buildApp } from "./http.js";

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
    const upload = new FormData();
    upload.append("file", new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "shot.png", { type: "image/png" }));
    const uploadRes = await app.request(`/api/threads/${id}/attachments`, { method: "POST", body: upload });
    const attachment = (await uploadRes.json() as any).attachment;
    const result = await req(app, "POST", `/api/threads/${id}/send`, { content: "Inspect screenshot", attachment_ids: [attachment.id] });
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
});
