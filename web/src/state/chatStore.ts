import { create } from "zustand";
import {
  chatMessagesFor,
  chatMessagesReducer,
  chatPermissionsFor,
  chatPermissionsReducer,
  chatThreadsReducer,
  chatThreadsToList,
  type ChatMessagesState,
  type ChatPermissionsState,
  type ChatThreadsState,
} from "../board/reducer";
import type { AcpEvent, BusEvent, ChatMessage, ChatThread, PendingPermission } from "../types";

interface ChatStore {
  threadsById: ChatThreadsState;
  liveMessagesByThread: ChatMessagesState;
  permissionsByThread: ChatPermissionsState;
  eventsByThread: Record<string, AcpEvent[]>;
  composerDraftsByProject: Record<string, { agent: string; content: string }>;
  applyChatEvent: (event: BusEvent) => void;
  replaceThreads: (threads: ChatThread[]) => void;
  replaceEvents: (threadId: string, events: AcpEvent[]) => void;
  updateComposerDraft: (
    project: string,
    input: Partial<{ agent: string; content: string }>,
  ) => void;
  clearComposerDraft: (project: string) => void;
}

export const useChatStore = create<ChatStore>((set) => ({
  threadsById: {},
  liveMessagesByThread: {},
  permissionsByThread: {},
  eventsByThread: {},
  composerDraftsByProject: {},
  applyChatEvent: (event) =>
    set((state) => ({
      threadsById: chatThreadsReducer(state.threadsById, event),
      liveMessagesByThread: chatMessagesReducer(state.liveMessagesByThread, event),
      permissionsByThread: chatPermissionsReducer(state.permissionsByThread, event),
    })),
  replaceThreads: (threads) =>
    set((state) => ({
      threadsById: chatThreadsReducer(state.threadsById, {
        type: "connected",
        payload: { threads },
        timestamp: new Date().toISOString(),
      }),
    })),
  replaceEvents: (threadId, events) =>
    set((state) => ({ ...state, eventsByThread: { ...state.eventsByThread, [threadId]: events } })),
  updateComposerDraft: (project, input) =>
    set((state) => ({
      composerDraftsByProject: {
        ...state.composerDraftsByProject,
        [project]: {
          agent: input.agent ?? state.composerDraftsByProject[project]?.agent ?? "",
          content: input.content ?? state.composerDraftsByProject[project]?.content ?? "",
        },
      },
    })),
  clearComposerDraft: (project) =>
    set((state) => {
      const composerDraftsByProject = { ...state.composerDraftsByProject };
      delete composerDraftsByProject[project];
      return { composerDraftsByProject };
    }),
}));

export const selectThreads = (state: ChatStore): ChatThread[] =>
  chatThreadsToList(state.threadsById);
export const selectMessages =
  (id: string) =>
  (state: ChatStore): ChatMessage[] =>
    chatMessagesFor(state.liveMessagesByThread, id);
export const selectPermissions =
  (id: string) =>
  (state: ChatStore): PendingPermission[] =>
    chatPermissionsFor(state.permissionsByThread, id);
