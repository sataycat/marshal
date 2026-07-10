import { useCallback, useEffect, useReducer, useState } from "react";
import { boardReducer, boardToList, type BoardState } from "../board/reducer";
import {
  specMessagesReducer,
  messagesForSlug,
  type SpecMessagesState,
} from "../specchat/specMessagesReducer";
import { connectBus, fetchTasks, type SocketStatus, type WebSocketHandle } from "../api/client";
import type { BusEvent, SpecMessage } from "../types";

export interface BoardView {
  tasks: ReturnType<typeof boardToList>;
  specMessagesFor: (slug: string) => SpecMessage[];
  status: SocketStatus;
  dispatch: (event: BusEvent) => void;
}

export function useBoard(): BoardView {
  const [state, dispatchTasks] = useReducer(boardReducer, {} as BoardState);
  const [specState, dispatchSpec] = useReducer(specMessagesReducer, {} as SpecMessagesState);
  const [status, setStatus] = useState<SocketStatus>("connecting");

  const dispatch = useCallback((event: BusEvent): void => {
    dispatchTasks(event);
    dispatchSpec(event);
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
  };
}
