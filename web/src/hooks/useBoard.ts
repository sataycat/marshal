import { useCallback, useEffect, useReducer, useState } from "react";
import { boardReducer, boardToList, chatMessagesFor, chatMessagesReducer, chatPermissionsFor, chatPermissionsReducer, chatThreadsReducer, chatThreadsToList, type BoardState, type ChatMessagesState, type ChatPermissionsState, type ChatThreadsState } from "../board/reducer";
import {
  specMessagesReducer,
  messagesForSlug,
  type SpecMessagesState,
} from "../specchat/specMessagesReducer";
import { connectBus, fetchChatThreads, fetchTasks, type SocketStatus, type WebSocketHandle } from "../api/client";
import type { BusEvent, ChatMessage, ChatThread, PendingPermission, SpecMessage } from "../types";

export interface BoardView {
  tasks: ReturnType<typeof boardToList>;
  specMessagesFor: (slug: string) => SpecMessage[];
  status: SocketStatus;
  dispatch: (event: BusEvent) => void;
  threads: ChatThread[];
  messagesForThread: (id: string) => ChatMessage[];
  permissionsForThread: (id: string) => PendingPermission[];
}

export function useBoard(): BoardView {
  const [state, dispatchTasks] = useReducer(boardReducer, {} as BoardState);
  const [specState, dispatchSpec] = useReducer(specMessagesReducer, {} as SpecMessagesState);
  const [status, setStatus] = useState<SocketStatus>("connecting");
  const [threadState, dispatchThreads] = useReducer(chatThreadsReducer, {} as ChatThreadsState);
  const [messageState, dispatchMessages] = useReducer(chatMessagesReducer, {} as ChatMessagesState);
  const [permissionState, dispatchPermissions] = useReducer(chatPermissionsReducer, {} as ChatPermissionsState);

  const dispatch = useCallback((event: BusEvent): void => {
    dispatchTasks(event);
    dispatchSpec(event);
    dispatchThreads(event);
    dispatchMessages(event);
    dispatchPermissions(event);
  }, []);

  const specMessagesFor = useCallback(
    (slug: string): SpecMessage[] => messagesForSlug(specState, slug),
    [specState],
  );

  useEffect(() => {
    let cancelled = false;
    let handle: WebSocketHandle | undefined;

    fetchTasks()
      .then((tasks) => {
        if (cancelled) return;
        const seed: BusEvent = {
          type: "connected",
          payload: { tasks },
          timestamp: new Date().toISOString(),
        };
        dispatch(seed);
      })
      .catch(() => {
        // The WebSocket connected snapshot will recover state.
      });

    handle = connectBus(dispatch, { onStatus: (s) => setStatus(s) });

    fetchChatThreads().then((threads) => {
      if (cancelled) return;
      dispatchThreads({ type: "connected", payload: { threads }, timestamp: new Date().toISOString() });
    }).catch(() => undefined);

    return () => {
      cancelled = true;
      handle?.close();
    };
  }, [dispatch]);

  return {
    tasks: boardToList(state),
    specMessagesFor,
    status,
    dispatch,
    threads: chatThreadsToList(threadState),
    messagesForThread: (id: string) => chatMessagesFor(messageState, id),
    permissionsForThread: (id: string) => chatPermissionsFor(permissionState, id),
  };
}
