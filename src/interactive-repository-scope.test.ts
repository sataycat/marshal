import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { registerRepository } from "./repositories/store.js";
import { createChatAttachment, getChatAttachment, listChatAttachments } from "./chat/attachments.js";
import { createChatThread } from "./chat/store.js";
import { createPermissionRequest, getPermissionRequest, listPermissionRequests } from "./acp/permission-store.js";
import { appendEvent, createPrompt, createSession, getSession, listSessionEvents } from "./acp/supervisor-store.js";
import { openDatabase } from "./db/index.js";

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

function repo(machineDir: string) {
  return registerRepository(mkdtempSync(join(tmpdir(), "marshal-scope-repo-")), machineDir);
}

describe("interactive repository ownership", () => {
  it("keeps threads, attachments, sessions, events, and permissions in their repository scope", () => {
    const machineDir = mkdtempSync(join(tmpdir(), "marshal-scope-machine-"));
    const first = repo(machineDir);
    const second = repo(machineDir);
    const thread = createChatThread(first.id, { agentId: "agent", agentVersion: "1" }, machineDir);
    const attachment = createChatAttachment(first.id, thread.id, { type: "image/png", name: "proof.png", size: png.length, bytes: png }, machineDir);
    const session = createSession(first.id, { ownerType: "thread", ownerId: thread.id, agentId: "agent", agentVersion: "1" }, machineDir);
    const prompt = createPrompt(first.id, session.id, "hello", machineDir);
    const permission = createPermissionRequest(first.id, session.id, thread.id, { requestId: "request", sessionId: "acp", tool: "write", options: [] }, machineDir);
    appendEvent(first.id, session.id, prompt.id, "done", { ok: true }, { ok: true }, machineDir);

    expect(listChatAttachments(first.id, thread.id, machineDir)).toHaveLength(1);
    expect(() => listChatAttachments(second.id, thread.id, machineDir)).toThrow("Chat session not found");
    expect(() => getChatAttachment(second.id, thread.id, attachment.id, machineDir)).toThrow("Chat session not found");
    expect(getSession(second.id, session.id, machineDir)).toBeUndefined();
    expect(listSessionEvents(second.id, session.id, machineDir)).toEqual([]);
    expect(getPermissionRequest(second.id, permission.id, machineDir)).toBeUndefined();
    expect(listPermissionRequests(second.id, thread.id, machineDir)).toEqual([]);
  });

  it("rejects cross-repository inserts enforced by composite foreign keys", () => {
    const machineDir = mkdtempSync(join(tmpdir(), "marshal-fk-machine-"));
    const first = repo(machineDir);
    const second = repo(machineDir);
    const thread = createChatThread(first.id, { agentId: "agent", agentVersion: "1" }, machineDir);
    const db = openDatabase(machineDir);
    expect(() => db.prepare("INSERT INTO chat_messages (repository_id, thread_id, role, content) VALUES (?, ?, 'user', 'bad')").run(second.id, thread.id)).toThrow();
    expect(() => db.prepare("INSERT INTO tasks (repository_id, slug, title, workflow_profile_id) VALUES (?, 'bad', 'bad', NULL)").run("missing-repository")).toThrow();
  });
});
