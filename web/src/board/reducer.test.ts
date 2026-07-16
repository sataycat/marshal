import { describe, it, expect } from "vitest";
import {
  boardReducer,
  boardToList,
  chatMessagesFor,
  chatMessagesReducer,
  chatThreadsReducer,
  chatThreadsToList,
  type BoardState,
  type ChatMessagesState,
  type ChatThreadsState,
} from "./reducer";
import type { BusEvent, ChatMessage, ChatThread, TaskCard } from "../types";

function card(over: Partial<TaskCard> = {}): TaskCard {
  return {
    id: 1,
    slug: "x",
    title: "X",
    status: "backlog",
    retry_count: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function ev(type: string, payload: unknown): BusEvent {
  return { type, payload, timestamp: "2026-01-01T00:00:00.000Z" };
}

describe("boardReducer", () => {
  it("connected replaces state with the snapshot", () => {
    const state: BoardState = { 9: card({ id: 9 }) };
    const next = boardReducer(
      state,
      ev("connected", { tasks: [card({ id: 1, slug: "a" }), card({ id: 2, slug: "b" })] }),
    );
    expect(Object.keys(next).sort()).toEqual(["1", "2"]);
    expect(next[9]).toBeUndefined();
  });

  it("task.created adds a task", () => {
    const next = boardReducer({}, ev("task.created", card({ id: 5, slug: "new" })));
    expect(next[5]?.slug).toBe("new");
  });

  it("task.transitioned updates an existing task in place", () => {
    const state: BoardState = { 1: card({ id: 1, status: "ready" }) };
    const next = boardReducer(
      state,
      ev("task.transitioned", {
        ...card({ id: 1, status: "building" }),
        from: "ready",
        to: "building",
      }),
    );
    expect(next[1]?.status).toBe("building");
  });

  it("task.updated upserts an unknown task defensively", () => {
    const next = boardReducer({}, ev("task.updated", card({ id: 7, status: "review" })));
    expect(next[7]?.status).toBe("review");
  });

  it("unknown event types leave state unchanged (same reference)", () => {
    const state: BoardState = { 1: card({ id: 1 }) };
    const next = boardReducer(state, ev("run.started", { id: 99 }));
    expect(next).toBe(state);
  });

  it("optimistic.apply upserts an optimistic task without touching others", () => {
    const state: BoardState = { 1: card({ id: 1, status: "ready" }) };
    const next = boardReducer(
      state,
      ev("optimistic.apply", card({ id: 1, status: "building" })),
    );
    expect(next[1]?.status).toBe("building");
  });

  it("optimistic.commit replaces the optimistic task with the server task", () => {
    const state: BoardState = { 1: card({ id: 1, status: "building" }) };
    const server = card({ id: 1, status: "validating", updated_at: "2026-01-03T00:00:00.000Z" });
    const next = boardReducer(state, ev("optimistic.commit", server));
    expect(next[1]).toEqual(server);
  });

  it("optimistic.rollback restores the previous task", () => {
    const state: BoardState = { 1: card({ id: 1, status: "building" }) };
    const previous = card({ id: 1, status: "ready" });
    const next = boardReducer(state, ev("optimistic.rollback", previous));
    expect(next[1]?.status).toBe("ready");
  });

  it("optimistic events leave other tasks untouched", () => {
    const state: BoardState = {
      1: card({ id: 1, status: "ready" }),
      2: card({ id: 2, status: "backlog" }),
    };
    const next = boardReducer(
      state,
      ev("optimistic.apply", card({ id: 1, status: "building" })),
    );
    expect(next[2]).toEqual(state[2]);
  });
});

describe("boardToList", () => {
  it("orders newest first by created_at, breaking ties by id desc", () => {
    const state: BoardState = {
      1: card({ id: 1, created_at: "2026-01-01T00:00:00.000Z" }),
      2: card({ id: 2, created_at: "2026-01-02T00:00:00.000Z" }),
      3: card({ id: 3, created_at: "2026-01-01T00:00:00.000Z" }),
    };
    expect(boardToList(state).map((t) => t.id)).toEqual([2, 3, 1]);
  });

  it("returns an empty array for empty state", () => {
    expect(boardToList({})).toEqual([]);
  });
});

function thread(overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id: "thread-1",
    repo_root: "/repo",
    cwd: "/repo",
    agent_id: "builder",
    title: "Thread",
    status: "draft",
    archived: false,
    pinned: false,
    task_slug: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    last_message_at: null,
    scratch_markdown: "",
    ...overrides,
  };
}

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 1,
    thread_id: "thread-1",
    role: "assistant",
    content: "hello",
    created_at: "2026-01-01T00:00:00.000Z",
    attachment_ids: [],
    ...overrides,
  };
}

describe("chat state reducers", () => {
  it("replaces thread state from a connected snapshot", () => {
    const state: ChatThreadsState = { old: thread({ id: "old" }) };
    const next = chatThreadsReducer(state, ev("connected", { threads: [thread()] }));
    expect(Object.keys(next)).toEqual(["thread-1"]);
  });

  it("upserts live thread updates and sorts pinned threads before recent threads", () => {
    let state: ChatThreadsState = {};
    state = chatThreadsReducer(state, ev("thread.created", { thread: thread({ id: "old", updated_at: "2026-01-03T00:00:00.000Z" }) }));
    state = chatThreadsReducer(state, ev("thread.updated", { thread: thread({ id: "pinned", pinned: true }) }));
    expect(chatThreadsToList(state).map((item) => item.id)).toEqual(["pinned", "old"]);
  });

  it("deduplicates streamed messages by id and returns them in order", () => {
    const state: ChatMessagesState = {};
    const withFirst = chatMessagesReducer(state, ev("thread.message", { threadId: "thread-1", message: message({ id: 2, content: "partial" }) }));
    const withUpdate = chatMessagesReducer(withFirst, ev("thread.message", { threadId: "thread-1", message: message({ id: 2, content: "complete" }) }));
    const withSecond = chatMessagesReducer(withUpdate, ev("thread.message", { threadId: "thread-1", message: message({ id: 3, content: "next" }) }));
    expect(chatMessagesFor(withSecond, "thread-1").map((item) => item.content)).toEqual(["complete", "next"]);
  });
});
