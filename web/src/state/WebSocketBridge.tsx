import { useEffect, type ReactNode } from "react";
import { connectBus, fetchChatEvents, fetchChatThreads, fetchTasks, type WebSocketHandle } from "../api/client";
import { queryClient } from "../api/queryClient";
import { queryKeys } from "../api/queryKeys";
import { reconcileBusEvent } from "./queryReconciliation";
import { useChatStore } from "./chatStore";
import { useTaskStore } from "./taskStore";
import { useRepositoriesQuery } from "../api/queries";

export function WebSocketBridge({ children }: { children: ReactNode }): JSX.Element {
  const repositories = useRepositoriesQuery();
  const repositoryId = repositories.data?.selected_repository_id ?? null;
  useEffect(() => {
    let cancelled = false;
    const applyTaskEvent = useTaskStore.getState().applyTaskEvent;
    const applyChatEvent = useChatStore.getState().applyChatEvent;
    let handle: WebSocketHandle | undefined;

    const connect = (repositoryId: string | null): void => {
      if (cancelled) return;
      handle = connectBus((event) => {
        applyTaskEvent(event);
        applyChatEvent(event);
        reconcileBusEvent(queryClient, event);
        if (event.type === "installation.operation.updated") {
          const operation = (event.payload as { operation?: unknown }).operation;
          if (operation && typeof operation === "object" && "id" in operation) queryClient.setQueryData(queryKeys.installation(String((operation as { id: string }).id)), operation);
          void queryClient.invalidateQueries({ queryKey: queryKeys.installedAgents });
        }
      }, { repositoryId, onStatus: (status) => useTaskStore.getState().setSocketStatus(status) });
    };
    fetchTasks().then((tasks) => {
      if (!cancelled) {
        applyTaskEvent({ type: "connected", payload: { tasks }, timestamp: new Date().toISOString() });
        queryClient.setQueryData(queryKeys.tasks(), tasks);
      }
    }).catch(() => undefined);
    if (!repositoryId) {
      connect(null);
      return () => {
        cancelled = true;
        handle?.close();
      };
    }
    fetchChatThreads(repositoryId).then((threads) => {
        if (cancelled) return;
        useChatStore.getState().replaceThreads(threads);
        queryClient.setQueryData(queryKeys.threads(false, repositoryId), threads);
        return Promise.all(threads.map(async (thread) => [thread.id, await fetchChatEvents(thread.id, repositoryId)] as const));
    }).then((entries) => {
      if (!cancelled && entries) for (const [threadId, events] of entries) useChatStore.getState().replaceEvents(threadId, events);
      connect(repositoryId);
    }).catch(() => connect(repositoryId));

    return () => {
      cancelled = true;
      handle?.close();
    };
  }, [repositoryId]);

  return <>{children}</>;
}
