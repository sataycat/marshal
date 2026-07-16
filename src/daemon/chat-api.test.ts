import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "./http.js";

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

describe("chat thread API", () => {
  it("creates, opens, updates, and appends to a thread without starting an agent", async () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-chat-api-"));
    initGitRepo(root);
    const app = buildApp("0.0.1", { root });

    const created = await req(app, "POST", "/api/threads", { agent_id: "agent-a", title: "Debug login" });
    expect(created.status).toBe(201);
    const id = created.body.thread.id;
    expect(created.body.thread).toMatchObject({ agent_id: "agent-a", title: "Debug login", status: "draft" });

    const message = await req(app, "POST", `/api/threads/${id}/messages`, { role: "user", content: "Please inspect this." });
    expect(message.status).toBe(201);
    expect(message.body.message).toMatchObject({ thread_id: id, role: "user", content: "Please inspect this." });

    const updated = await req(app, "PATCH", `/api/threads/${id}`, { pinned: true, status: "closed" });
    expect(updated.status).toBe(200);
    expect(updated.body.thread).toMatchObject({ id, pinned: true, status: "closed" });

    const detail = await req(app, "GET", `/api/threads/${id}`);
    expect(detail.body.messages).toHaveLength(1);
  });

  it("rejects unknown thread fields and missing agent IDs", async () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-chat-api-"));
    initGitRepo(root);
    const app = buildApp("0.0.1", { root });
    expect((await req(app, "POST", "/api/threads", { title: "No agent" })).status).toBe(422);
    expect((await req(app, "POST", "/api/threads", { agent_id: "a", nope: true })).status).toBe(400);
  });

  it("supports lifecycle actions and deletion", async () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-chat-api-"));
    initGitRepo(root);
    const app = buildApp("0.0.1", { root });
    const created = await req(app, "POST", "/api/threads", { agent_id: "agent-a" });
    const id = created.body.thread.id;
    expect((await req(app, "PATCH", `/api/threads/${id}`, { archived: true, pinned: true, status: "closed" })).body.thread).toMatchObject({ archived: true, pinned: true, status: "closed" });
    expect((await req(app, "GET", "/api/threads")).body.threads).toHaveLength(0);
    expect((await req(app, "GET", "/api/threads?archived=true")).body.threads[0]).toMatchObject({ id, archived: true });
    expect((await req(app, "DELETE", `/api/threads/${id}`)).body).toEqual({ deleted: true });
    expect((await req(app, "GET", `/api/threads/${id}`)).status).toBe(404);
  });
});
