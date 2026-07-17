import { beforeEach, describe, expect, it } from "vitest";
import { useChatStore } from "./chatStore";
import type { ChatMessage, ChatThread } from "../types";

function thread(id: string): ChatThread {
  return {
    id, repo_root: "/repo", cwd: "/repo", agent_id: "builder", title: id,
    status: "draft", archived: false, pinned: false, task_slug: null,
    created_at: "2026-01-01", updated_at: "2026-01-01", last_message_at: null,
    scratch_markdown: "",
  };
}

function message(id: number): ChatMessage {
  return { id, thread_id: "thread", role: "assistant", content: String(id), created_at: "2026-01-01", attachment_ids: [] };
}

describe("chatStore", () => {
  beforeEach(() => useChatStore.setState({ threadsById: {}, liveMessagesByThread: {}, permissionsByThread: {} }));

  it("replaces threads and merges duplicate live messages by id", () => {
    const store = useChatStore.getState();
    store.replaceThreads([thread("new")]);
    store.applyChatEvent({ type: "thread.message", payload: { threadId: "thread", message: message(2) }, timestamp: "now" });
    store.applyChatEvent({ type: "thread.message", payload: { threadId: "thread", message: { ...message(2), content: "updated" } }, timestamp: "now" });
    expect(Object.keys(useChatStore.getState().threadsById)).toEqual(["new"]);
    expect(useChatStore.getState().liveMessagesByThread.thread[2]?.content).toBe("updated");
  });
});
