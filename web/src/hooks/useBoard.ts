import { useEffect, useReducer, useState } from "react";
import { boardReducer, boardToList, type BoardState } from "../board/reducer";
import { connectBus, fetchTasks, type SocketStatus, type WebSocketHandle } from "../api/client";
import type { BusEvent, TaskCard } from "../types";

export interface BoardView {
  tasks: TaskCard[];
  status: SocketStatus;
}

export function useBoard(): BoardView {
  const [state, dispatch] = useReducer(boardReducer, {} as BoardState);
  const [status, setStatus] = useState<SocketStatus>("connecting");

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
  }, []);

  return { tasks: boardToList(state), status };
}
