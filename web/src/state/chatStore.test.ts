import { beforeEach, describe, expect, it } from "vitest";
import { useChatStore } from "./chatStore";
import type { ChatMessage, ChatThread } from "../types";

function thread(id: string): ChatThread {
  return {
    id,
    repo_root: "/repo",
    cwd: "/repo",
    agent_id: "builder",
    agent_version: "1.0.0",
    title: id,
    status: "active",
    archived: false,
    pinned: false,
    task_slug: null,
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
    last_message_at: null,
    scratch_markdown: "",
    session_config_options: [],
    session_modes: null,
    session_initialized: false,
  };
}

function message(id: number): ChatMessage {
  return {
    id,
    thread_id: "thread",
    role: "assistant",
    content: String(id),
    created_at: "2026-01-01",
    attachment_ids: [],
  };
}

describe("chatStore", () => {
  beforeEach(() =>
    useChatStore.setState({
      threadsById: {},
      liveMessagesByThread: {},
      permissionsByThread: {},
      composerDraftsByProject: {},
    }),
  );

  it("replaces threads and merges duplicate live messages by id", () => {
    const store = useChatStore.getState();
    store.replaceThreads([thread("new")]);
    store.applyChatEvent({
      type: "thread.message",
      payload: { threadId: "thread", message: message(2) },
      timestamp: "now",
    });
    store.applyChatEvent({
      type: "thread.message",
      payload: { threadId: "thread", message: { ...message(2), content: "updated" } },
      timestamp: "now",
    });
    expect(Object.keys(useChatStore.getState().threadsById)).toEqual(["new"]);
    expect(useChatStore.getState().liveMessagesByThread.thread[2]?.content).toBe("updated");
  });

  it("keeps one non-durable composer draft per project", () => {
    const store = useChatStore.getState();
    store.updateComposerDraft("/repo-a", { agent: "builder@1.0.0", content: "First" });
    store.updateComposerDraft("/repo-a", { content: "Updated" });
    store.updateComposerDraft("/repo-b", { content: "Other" });

    expect(useChatStore.getState().composerDraftsByProject).toEqual({
      "/repo-a": { agent: "builder@1.0.0", content: "Updated" },
      "/repo-b": { agent: "", content: "Other" },
    });

    store.clearComposerDraft("/repo-a");
    expect(useChatStore.getState().composerDraftsByProject).toEqual({
      "/repo-b": { agent: "", content: "Other" },
    });
  });
});
