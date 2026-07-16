import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendChatMessage, createChatThread, deleteChatThread, getChatThread, listChatMessages, listChatThreads, updateChatThread } from "./store.js";

describe("chat thread store", () => {
  it("creates a draft, persists messages, and activates on the first message", () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-chat-store-"));
    const thread = createChatThread({ agentId: "agent-a" }, root);
    expect(thread.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(thread.status).toBe("draft");
    expect(listChatMessages(thread.id, root)).toEqual([]);

    const message = appendChatMessage(thread.id, "user", "Hello", root);
    expect(message).toMatchObject({ thread_id: thread.id, role: "user", content: "Hello" });
    expect(getChatThread(thread.id, root).status).toBe("active");
    expect(listChatMessages(thread.id, root)).toHaveLength(1);
  });

  it("updates lifecycle metadata and hides archived threads by default", () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-chat-store-"));
    const thread = createChatThread({ agentId: "agent-a", title: "Keep me" }, root);
    updateChatThread(thread.id, { status: "closed", archived: true, pinned: true }, root);
    expect(listChatThreads(root)).toEqual([]);
    expect(listChatThreads(root, true)[0]).toMatchObject({ id: thread.id, status: "closed", archived: true, pinned: true });
  });

  it("persists a per-thread scratch markdown buffer", () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-chat-store-"));
    const thread = createChatThread({ agentId: "agent-a" }, root);
    updateChatThread(thread.id, { scratchMarkdown: "# Draft\n\nKeep this." }, root);
    expect(getChatThread(thread.id, root).scratch_markdown).toBe("# Draft\n\nKeep this.");
  });

  it("does not open a thread from another repository", () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-chat-store-"));
    const otherRoot = mkdtempSync(join(tmpdir(), "marshal-chat-store-"));
    const thread = createChatThread({ agentId: "agent-a" }, root);
    expect(() => getChatThread(thread.id, otherRoot)).toThrow("Chat thread not found");
  });

  it("deletes a thread and its messages", () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-chat-store-"));
    const thread = createChatThread({ agentId: "agent-a" }, root);
    appendChatMessage(thread.id, "user", "discard me", root);
    deleteChatThread(thread.id, root);
    expect(listChatThreads(root, true)).toEqual([]);
    expect(() => getChatThread(thread.id, root)).toThrow("Chat thread not found");
  });
});
