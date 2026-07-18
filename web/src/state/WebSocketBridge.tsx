import { useEffect, type ReactNode } from "react";
import { connectBus, fetchChatThreads, fetchTasks, type WebSocketHandle } from "../api/client";
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
    handle = connectBus((event) => {
      applyTaskEvent(event);
      applyChatEvent(event);
      reconcileBusEvent(queryClient, event);
    }, { onStatus: (status) => useTaskStore.getState().setSocketStatus(status) });

    return () => {
      cancelled = true;
      handle?.close();
    };
  }, []);

  return <>{children}</>;
}
