export type BoardState = Record<number, TaskCard>;

import type { BusEvent, ChatMessage, ChatThread, PendingPermission, TaskCard, ThreadMessagePayload, ThreadPayload } from "../types";

export function boardReducer(state: BoardState, event: BusEvent): BoardState {
  switch (event.type) {
    case "connected": {
      const tasks = (event.payload as { tasks: TaskCard[] }).tasks;
      const next: BoardState = {};
      for (const task of tasks) next[task.id] = task;
      return next;
    }
    case "task.created":
    case "task.updated":
    case "task.transitioned":
    case "optimistic.apply":
    case "optimistic.commit":
    case "optimistic.rollback": {
      const task = event.payload as TaskCard;
      return { ...state, [task.id]: task };
    }
    default:
      return state;
  }
}

export type ChatThreadsState = Record<string, ChatThread>;
export type ChatMessagesState = Record<string, Record<number, ChatMessage>>;
export type ChatPermissionsState = Record<string, Record<string, PendingPermission>>;

export function chatPermissionsReducer(state: ChatPermissionsState, event: BusEvent): ChatPermissionsState {
  if (event.type !== "thread.event") return state;
  const payload = event.payload as { threadId?: string; event?: { type?: string; request?: PendingPermission; requestId?: string } };
  if (!payload.threadId || !payload.event) return state;
  if (payload.event.type === "permission-request" && payload.event.request) {
    return { ...state, [payload.threadId]: { ...state[payload.threadId], [payload.event.request.requestId]: payload.event.request } };
  }
  if (payload.event.type === "permission-resolved" && payload.event.requestId) {
    const next = { ...state[payload.threadId] };
    delete next[payload.event.requestId];
    return { ...state, [payload.threadId]: next };
  }
  return state;
}

export function chatPermissionsFor(state: ChatPermissionsState, id: string): PendingPermission[] {
  return Object.values(state[id] ?? {});
}

export function chatThreadsReducer(state: ChatThreadsState, event: BusEvent): ChatThreadsState {
  if (event.type === "connected") {
    const next: ChatThreadsState = {};
    for (const thread of (event.payload as { threads?: ChatThread[] }).threads ?? []) next[thread.id] = thread;
    return next;
  }
  if (event.type === "thread.created" || event.type === "thread.updated") {
    const thread = (event.payload as ThreadPayload).thread;
    return { ...state, [thread.id]: thread };
  }
  if (event.type === "thread.deleted") {
    const id = (event.payload as { id: string }).id;
    const next = { ...state };
    delete next[id];
    return next;
  }
  return state;
}

export function chatMessagesReducer(state: ChatMessagesState, event: BusEvent): ChatMessagesState {
  if (event.type === "thread.message") {
    const { threadId, message } = event.payload as ThreadMessagePayload;
    return { ...state, [threadId]: { ...state[threadId], [message.id]: message } };
  }
  if (event.type === "connected") return state;
  return state;
}

export function chatThreadsToList(state: ChatThreadsState): ChatThread[] {
  return Object.values(state).filter((thread) => !thread.archived).sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const aDate = a.last_message_at ?? a.updated_at;
    const bDate = b.last_message_at ?? b.updated_at;
    return aDate < bDate ? 1 : -1;
  });
}

export function chatMessagesFor(state: ChatMessagesState, id: string): ChatMessage[] {
  return Object.values(state[id] ?? {}).sort((a, b) => a.id - b.id);
}

export function boardToList(state: BoardState): TaskCard[] {
  return Object.values(state).sort((a, b) => {
    if (a.created_at === b.created_at) return b.id - a.id;
    return a.created_at < b.created_at ? 1 : -1;
  });
}
