import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerRepository } from "../repositories/store.js";
import {
  appendChatMessage,
  createChatThread,
  deleteChatThread,
  getChatThread,
  listChatMessages,
  listChatThreads,
  updateChatThread,
} from "./store.js";

function repository(machine: string) {
  return registerRepository(mkdtempSync(join(tmpdir(), "marshal-chat-repo-")), machine);
}

describe("chat session store", () => {
  it("creates an active session and persists messages under an explicit repository", () => {
    const machine = mkdtempSync(join(tmpdir(), "marshal-chat-machine-"));
    const repo = repository(machine);
    const thread = createChatThread(repo.id, { agentId: "agent-a", agentVersion: "1.0.0" }, machine);
    expect(thread.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(thread.repository_id).toBe(repo.id);
    expect(thread.status).toBe("active");
    expect(listChatMessages(repo.id, thread.id, machine)).toEqual([]);

    const message = appendChatMessage(repo.id, thread.id, "user", "Hello", [], machine);
    expect(message).toMatchObject({ repository_id: repo.id, thread_id: thread.id, role: "user", content: "Hello" });
    expect(getChatThread(repo.id, thread.id, machine).status).toBe("active");
    expect(listChatMessages(repo.id, thread.id, machine)).toHaveLength(1);
  });

  it("isolates two repositories and rejects cross-scope access", () => {
    const machine = mkdtempSync(join(tmpdir(), "marshal-chat-machine-"));
    const first = repository(machine);
    const second = repository(machine);
    const thread = createChatThread(first.id, { agentId: "agent-a", agentVersion: "1.0.0" }, machine);
    appendChatMessage(first.id, thread.id, "user", "private", [], machine);
    expect(listChatThreads(first.id, false, machine)).toHaveLength(1);
    expect(listChatThreads(second.id, false, machine)).toEqual([]);
    expect(() => listChatMessages(second.id, thread.id, machine)).toThrow("Chat session not found");
    expect(() => getChatThread(second.id, thread.id, machine)).toThrow("Chat session not found");
    expect(() => updateChatThread(second.id, thread.id, { title: "crossed" }, machine)).toThrow("Chat session not found");
  });

  it("updates lifecycle metadata and hides archived threads by default", () => {
    const machine = mkdtempSync(join(tmpdir(), "marshal-chat-machine-"));
    const repo = repository(machine);
    const thread = createChatThread(repo.id, { agentId: "agent-a", agentVersion: "1.0.0", title: "Keep me" }, machine);
    updateChatThread(repo.id, thread.id, { status: "closed", archived: true, pinned: true }, machine);
    expect(listChatThreads(repo.id, false, machine)).toEqual([]);
    expect(listChatThreads(repo.id, true, machine)[0]).toMatchObject({ id: thread.id, status: "closed", archived: true, pinned: true });
  });

  it("persists a per-thread scratch markdown buffer", () => {
    const machine = mkdtempSync(join(tmpdir(), "marshal-chat-machine-"));
    const repo = repository(machine);
    const thread = createChatThread(repo.id, { agentId: "agent-a", agentVersion: "1.0.0" }, machine);
    updateChatThread(repo.id, thread.id, { scratchMarkdown: "# Draft\n\nKeep this." }, machine);
    expect(getChatThread(repo.id, thread.id, machine).scratch_markdown).toBe("# Draft\n\nKeep this.");
  });

  it("deletes a thread and its messages", () => {
    const machine = mkdtempSync(join(tmpdir(), "marshal-chat-machine-"));
    const repo = repository(machine);
    const thread = createChatThread(repo.id, { agentId: "agent-a", agentVersion: "1.0.0" }, machine);
    appendChatMessage(repo.id, thread.id, "user", "discard me", [], machine);
    deleteChatThread(repo.id, thread.id, machine);
    expect(listChatThreads(repo.id, true, machine)).toEqual([]);
    expect(() => getChatThread(repo.id, thread.id, machine)).toThrow("Chat session not found");
  });
});
