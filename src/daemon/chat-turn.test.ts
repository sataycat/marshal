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
  it("streams a turn, persists the transcript, and reuses the ACP session", async () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-chat-turn-"));
    initGitRepo(root);
    const agent = new FakeAgent();
    const bus = new EventBus();
    const events: string[] = [];
    bus.subscribe((event) => events.push(event.type));
    const app = buildApp("0.0.1", { root, bus, chatAgent: agent });
    const created = await req(app, "POST", "/api/threads", { agent_id: "fake" });
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
});
