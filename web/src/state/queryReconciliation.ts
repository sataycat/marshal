import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "../api/queryKeys";
import type { BusEvent, ChatMessage, PendingPermission, TaskCard, ThreadPayload, ThreadMessagePayload } from "../types";

export function mergeById<T extends { id: number }>(items: T[], next: T): T[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index < 0) return [...items, next];
  const result = [...items];
  result[index] = next;
  return result;
}

export function reconcileBusEvent(queryClient: QueryClient, event: BusEvent): void {
  if (event.type === "task.created" || event.type === "task.updated" || event.type === "task.transitioned") {
    const task = event.payload as TaskCard;
    queryClient.setQueryData<TaskCard[]>(queryKeys.tasks, (tasks) => tasks ? mergeById(tasks, task) : tasks);
    queryClient.invalidateQueries({ queryKey: queryKeys.task(task.slug), refetchType: "none" });
    if (task.status === "review") queryClient.invalidateQueries({ queryKey: queryKeys.taskDiff(task.slug), refetchType: "none" });
    return;
  }
  if (event.type === "thread.created" || event.type === "thread.updated") {
    const { thread } = event.payload as ThreadPayload;
    for (const archived of [false, true]) {
      queryClient.setQueryData(queryKeys.threads(archived), (threads: unknown) => {
        if (!Array.isArray(threads)) return threads;
        return mergeById(threads, thread);
      });
    }
    queryClient.setQueryData(queryKeys.thread(thread.id), (current: unknown) => {
      if (!current || typeof current !== "object") return current;
      return { ...(current as object), thread };
    });
    return;
  }
  if (event.type === "thread.deleted") {
    const { id } = event.payload as { id: string };
    for (const archived of [false, true]) {
      queryClient.setQueryData(queryKeys.threads(archived), (threads: unknown) => Array.isArray(threads) ? threads.filter((thread: { id: string }) => thread.id !== id) : threads);
    }
    queryClient.removeQueries({ queryKey: queryKeys.thread(id) });
    return;
  }
  if (event.type === "thread.message") {
    const { threadId, message } = event.payload as ThreadMessagePayload;
    queryClient.setQueryData<{ thread: unknown; messages: ChatMessage[] }>(queryKeys.thread(threadId), (current) => current ? { ...current, messages: mergeById(current.messages, message) } : current);
    return;
  }
  if (event.type === "thread.event") {
    const payload = event.payload as { threadId?: string; event?: { type?: string; request?: PendingPermission; requestId?: string } };
    if (!payload.threadId || !payload.event) return;
    const permissionEvent = payload.event;
    if (permissionEvent.type === "permission-request" && permissionEvent.request) {
      queryClient.setQueryData<PendingPermission[]>(queryKeys.permissions(payload.threadId), (items) => {
        const next = permissionEvent.request!;
        const existing = items ?? [];
        const index = existing.findIndex((item) => item.requestId === next.requestId);
        if (index < 0) return [...existing, next];
        const result = [...existing];
        result[index] = next;
        return result;
      });
    } else if (permissionEvent.type === "permission-resolved" && permissionEvent.requestId) {
      queryClient.setQueryData<PendingPermission[]>(queryKeys.permissions(payload.threadId), (items) => items?.filter((item) => item.requestId !== permissionEvent.requestId));
    }
  }
}
