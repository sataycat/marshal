import { createContext, useCallback, useContext, useMemo, useReducer, type ReactNode } from "react";
import { useBoard } from "../hooks/useBoard";
import {
  addErrorToast,
  addInfoToast,
  toastReducer,
  type Toast,
} from "../toast/toast";
import {
  createTask as apiCreateTask,
  freezeTask as apiFreezeTask,
  mergeTask as apiMergeTask,
  transitionTask as apiTransitionTask,
  type SocketStatus,
} from "../api/client";
import { friendlyErrorMessage } from "../api/errors";
import { useConfirm, type ConfirmApi } from "../components/ConfirmDialog";
import type { BusEvent, TaskCard, TaskDetail, TaskStatus } from "../types";

export interface BoardContextValue {
  tasks: TaskCard[];
  status: SocketStatus;
  toasts: Toast[];
  dismissToast: (id: number) => void;
  pushError: (message: string) => void;
  pushInfo: (message: string) => void;
  confirm: ConfirmApi["confirm"];
  createTask: (input: { title: string; spec_markdown?: string }) => Promise<TaskDetail | null>;
  freezeTask: (
    slug: string,
    previous: TaskCard,
    specMarkdown?: string,
  ) => Promise<TaskDetail | null>;
  transitionTask: (
    slug: string,
    to: TaskStatus,
    previous: TaskCard,
  ) => Promise<TaskDetail | null>;
  mergeTask: (slug: string, previous: TaskCard) => Promise<TaskDetail | null>;
}

const BoardContext = createContext<BoardContextValue | null>(null);

function toCard(detail: TaskDetail): TaskCard {
  const { spec_markdown: _spec, last_failure: _fail, ...card } = detail;
  void _spec;
  void _fail;
  return card;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function BoardProvider({ children }: { children: ReactNode }) {
  const { tasks, status, dispatch } = useBoard();
  const [toasts, dispatchToast] = useReducer(toastReducer, []);
  const { confirm, dialog } = useConfirm();

  const pushError = useCallback((message: string) => {
    dispatchToast(addErrorToast(message));
  }, []);
  const pushInfo = useCallback((message: string) => {
    dispatchToast(addInfoToast(message));
  }, []);
  const dismissToast = useCallback((id: number) => {
    dispatchToast({ type: "dismiss", id });
  }, []);

  const createTask = useCallback(
    async (input: { title: string; spec_markdown?: string }): Promise<TaskDetail | null> => {
      try {
        const task = await apiCreateTask(input);
        const event: BusEvent = { type: "task.created", payload: toCard(task), timestamp: nowIso() };
        dispatch(event);
        return task;
      } catch (err) {
        pushError(friendlyErrorMessage(err));
        return null;
      }
    },
    [dispatch, pushError],
  );

  const freezeTask = useCallback(
    async (slug: string, previous: TaskCard, specMarkdown?: string): Promise<TaskDetail | null> => {
      const optimistic: TaskCard = { ...previous, status: "ready" };
      dispatch({ type: "optimistic.apply", payload: optimistic, timestamp: nowIso() });
      try {
        const task = await apiFreezeTask(slug, specMarkdown);
        dispatch({ type: "optimistic.commit", payload: toCard(task), timestamp: nowIso() });
        return task;
      } catch (err) {
        dispatch({ type: "optimistic.rollback", payload: previous, timestamp: nowIso() });
        pushError(friendlyErrorMessage(err));
        return null;
      }
    },
    [dispatch, pushError],
  );

  const transitionTask = useCallback(
    async (slug: string, to: TaskStatus, previous: TaskCard): Promise<TaskDetail | null> => {
      const optimistic: TaskCard = { ...previous, status: to };
      dispatch({ type: "optimistic.apply", payload: optimistic, timestamp: nowIso() });
      try {
        const task = await apiTransitionTask(slug, to);
        dispatch({ type: "optimistic.commit", payload: toCard(task), timestamp: nowIso() });
        return task;
      } catch (err) {
        dispatch({ type: "optimistic.rollback", payload: previous, timestamp: nowIso() });
        pushError(friendlyErrorMessage(err));
        return null;
      }
    },
    [dispatch, pushError],
  );

  const mergeTask = useCallback(
    async (slug: string, previous: TaskCard): Promise<TaskDetail | null> => {
      const optimistic: TaskCard = { ...previous, status: "done" };
      dispatch({ type: "optimistic.apply", payload: optimistic, timestamp: nowIso() });
      try {
        const result = await apiMergeTask(slug);
        dispatch({ type: "optimistic.commit", payload: toCard(result.task), timestamp: nowIso() });
        return result.task;
      } catch (err) {
        dispatch({ type: "optimistic.rollback", payload: previous, timestamp: nowIso() });
        pushError(friendlyErrorMessage(err));
        return null;
      }
    },
    [dispatch, pushError],
  );

  const value = useMemo<BoardContextValue>(
    () => ({
      tasks,
      status,
      toasts,
      dismissToast,
      pushError,
      pushInfo,
      confirm,
      createTask,
      freezeTask,
      transitionTask,
      mergeTask,
    }),
    [tasks, status, toasts, dismissToast, pushError, pushInfo, confirm, createTask, freezeTask, transitionTask, mergeTask],
  );

  return (
    <BoardContext.Provider value={value}>
      {children}
      {dialog}
    </BoardContext.Provider>
  );
}

export function useBoardContext(): BoardContextValue {
  const ctx = useContext(BoardContext);
  if (ctx === null) {
    throw new Error("useBoardContext must be used inside a BoardProvider");
  }
  return ctx;
}
