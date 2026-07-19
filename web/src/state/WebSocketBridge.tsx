import { useEffect, type ReactNode } from "react";
import { connectBus, fetchChatEvents, fetchChatThreads, fetchTasks, type WebSocketHandle } from "../api/client";
import { queryClient } from "../api/queryClient";
import { queryKeys } from "../api/queryKeys";
import { reconcileBusEvent } from "./queryReconciliation";
import { useChatStore } from "./chatStore";
import { useTaskStore } from "./taskStore";

export function WebSocketBridge({ children }: { children: ReactNode }): JSX.Element {
  useEffect(() => {
    let cancelled = false;
    const applyTaskEvent = useTaskStore.getState().applyTaskEvent;
    const applyChatEvent = useChatStore.getState().applyChatEvent;
    let handle: WebSocketHandle | undefined;

    fetchTasks().then((tasks) => {
      if (!cancelled) {
        applyTaskEvent({ type: "connected", payload: { tasks }, timestamp: new Date().toISOString() });
        queryClient.setQueryData(queryKeys.tasks(), tasks);
      }
    }).catch(() => undefined);
    fetchChatThreads().then((threads) => {
      if (!cancelled) {
        useChatStore.getState().replaceThreads(threads);
        queryClient.setQueryData(queryKeys.threads(false), threads);
      }
    }).catch(() => undefined);
    fetchChatThreads().then((threads) => Promise.all(threads.map(async (thread) => [thread.id, await fetchChatEvents(thread.id)] as const))).then((entries) => {
      if (!cancelled) for (const [threadId, events] of entries) useChatStore.getState().replaceEvents(threadId, events);
    }).catch(() => undefined);
    handle = connectBus((event) => {
      applyTaskEvent(event);
      applyChatEvent(event);
      reconcileBusEvent(queryClient, event);
      if (event.type === "installation.operation.updated") {
        const operation = (event.payload as { operation?: unknown }).operation;
        if (operation && typeof operation === "object" && "id" in operation) queryClient.setQueryData(queryKeys.installation(String((operation as { id: string }).id)), operation);
        void queryClient.invalidateQueries({ queryKey: queryKeys.installedAgents });
      }
    }, { onStatus: (status) => useTaskStore.getState().setSocketStatus(status) });

    return () => {
      cancelled = true;
      handle?.close();
    };
  }, []);

  return <>{children}</>;
}
