import { create } from "zustand";
import {
  boardReducer,
  boardToList,
  type BoardState,
} from "../board/reducer";
import {
  messagesForSlug,
  specMessagesReducer,
  type SpecMessagesState,
} from "../specchat/specMessagesReducer";
import {
  createTask as apiCreateTask,
  freezeTask as apiFreezeTask,
  mergeTask as apiMergeTask,
  sendSpecMessage as apiSendSpecMessage,
  transitionTask as apiTransitionTask,
  updateTaskSpec as apiUpdateTaskSpec,
  type SocketStatus,
} from "../api/client";
import { friendlyErrorMessage } from "../api/errors";
import { useToastStore } from "./toastStore";
import type { BusEvent, SpecMessage, TaskCard, TaskDetail, TaskStatus } from "../types";

interface TaskStore {
  tasksById: BoardState;
  specMessagesBySlug: SpecMessagesState;
  socketStatus: SocketStatus;
  applyTaskEvent: (event: BusEvent) => void;
  setSocketStatus: (status: SocketStatus) => void;
  createTask: (input: { title: string; spec_markdown?: string }) => Promise<TaskDetail | null>;
  freezeTask: (slug: string, previous: TaskCard, specMarkdown?: string) => Promise<TaskDetail | null>;
  transitionTask: (slug: string, to: TaskStatus, previous: TaskCard) => Promise<TaskDetail | null>;
  mergeTask: (slug: string, previous: TaskCard) => Promise<TaskDetail | null>;
  sendSpecMessage: (slug: string, content: string) => Promise<{ userMessage: SpecMessage; assistantMessage: SpecMessage } | null>;
  updateTaskSpec: (slug: string, specMarkdown: string) => Promise<TaskDetail | null>;
}

function toCard(detail: TaskDetail): TaskCard {
  const { spec_markdown: _spec, last_failure: _failure, ...card } = detail;
  return card;
}

function nowIso(): string {
  return new Date().toISOString();
}

function reportError(error: unknown): void {
  useToastStore.getState().pushError(friendlyErrorMessage(error));
}

export const useTaskStore = create<TaskStore>((set) => ({
  tasksById: {},
  specMessagesBySlug: {},
  socketStatus: "connecting",
  applyTaskEvent: (event) => set((state) => ({
    tasksById: boardReducer(state.tasksById, event),
    specMessagesBySlug: specMessagesReducer(state.specMessagesBySlug, event),
  })),
  setSocketStatus: (socketStatus) => set({ socketStatus }),
  createTask: async (input) => {
    try {
      const task = await apiCreateTask(input);
      useTaskStore.getState().applyTaskEvent({ type: "task.created", payload: toCard(task), timestamp: nowIso() });
      return task;
    } catch (error) {
      reportError(error);
      return null;
    }
  },
  freezeTask: async (slug, previous, specMarkdown) => {
    useTaskStore.getState().applyTaskEvent({ type: "optimistic.apply", payload: { ...previous, status: "ready" }, timestamp: nowIso() });
    try {
      const task = await apiFreezeTask(slug, specMarkdown);
      useTaskStore.getState().applyTaskEvent({ type: "optimistic.commit", payload: toCard(task), timestamp: nowIso() });
      return task;
    } catch (error) {
      useTaskStore.getState().applyTaskEvent({ type: "optimistic.rollback", payload: previous, timestamp: nowIso() });
      reportError(error);
      return null;
    }
  },
  transitionTask: async (slug, to, previous) => {
    useTaskStore.getState().applyTaskEvent({ type: "optimistic.apply", payload: { ...previous, status: to }, timestamp: nowIso() });
    try {
      const task = await apiTransitionTask(slug, to);
      useTaskStore.getState().applyTaskEvent({ type: "optimistic.commit", payload: toCard(task), timestamp: nowIso() });
      return task;
    } catch (error) {
      useTaskStore.getState().applyTaskEvent({ type: "optimistic.rollback", payload: previous, timestamp: nowIso() });
      reportError(error);
      return null;
    }
  },
  mergeTask: async (slug, previous) => {
    useTaskStore.getState().applyTaskEvent({ type: "optimistic.apply", payload: { ...previous, status: "done" }, timestamp: nowIso() });
    try {
      const result = await apiMergeTask(slug);
      useTaskStore.getState().applyTaskEvent({ type: "optimistic.commit", payload: toCard(result.task), timestamp: nowIso() });
      return result.task;
    } catch (error) {
      useTaskStore.getState().applyTaskEvent({ type: "optimistic.rollback", payload: previous, timestamp: nowIso() });
      reportError(error);
      return null;
    }
  },
  sendSpecMessage: async (slug, content) => {
    try {
      const result = await apiSendSpecMessage(slug, content);
      const apply = useTaskStore.getState().applyTaskEvent;
      apply({ type: "spec.message", payload: { taskSlug: slug, message: result.userMessage }, timestamp: nowIso() });
      apply({ type: "spec.message", payload: { taskSlug: slug, message: result.assistantMessage }, timestamp: nowIso() });
      return result;
    } catch (error) {
      reportError(error);
      return null;
    }
  },
  updateTaskSpec: async (slug, specMarkdown) => {
    try {
      const task = await apiUpdateTaskSpec(slug, specMarkdown);
      useTaskStore.getState().applyTaskEvent({ type: "task.updated", payload: toCard(task), timestamp: nowIso() });
      return task;
    } catch (error) {
      reportError(error);
      return null;
    }
  },
}));

export const selectTasks = (state: TaskStore): TaskCard[] => boardToList(state.tasksById);
export const selectSpecMessages = (slug: string) => (state: TaskStore): SpecMessage[] => messagesForSlug(state.specMessagesBySlug, slug);
