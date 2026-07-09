import type { BusEvent, TaskCard, TaskDetail } from "../types";

export async function fetchTasks(): Promise<TaskCard[]> {
  const res = await fetch("/api/tasks");
  if (!res.ok) throw new Error(`Failed to list tasks: ${res.status}`);
  const body = (await res.json()) as { tasks: TaskCard[] };
  return body.tasks;
}

export async function fetchTaskDetail(slug: string): Promise<TaskDetail> {
  const res = await fetch(`/api/tasks/${encodeURIComponent(slug)}`);
  if (!res.ok) throw new Error(`Failed to load task ${slug}: ${res.status}`);
  const body = (await res.json()) as { task: TaskDetail };
  return body.task;
}

function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

export type SocketStatus = "connecting" | "open" | "closed";

export interface WebSocketHandle {
  close(): void;
}

export function connectBus(
  onEvent: (event: BusEvent) => void,
  options: { onStatus?: (status: SocketStatus) => void; reconnectMs?: number } = {},
): WebSocketHandle {
  const reconnectMs = options.reconnectMs ?? 1000;
  let closed = false;
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const open = (): void => {
    ws = new WebSocket(wsUrl());
    ws.onopen = () => options.onStatus?.("open");
    ws.onmessage = (ev) => {
      try {
        onEvent(JSON.parse(ev.data as string) as BusEvent);
      } catch {
        // ignore malformed frames
      }
    };
    ws.onerror = () => {
      try {
        ws?.close();
      } catch {
        // ignore
      }
    };
    ws.onclose = () => {
      options.onStatus?.("closed");
      if (closed) return;
      reconnectTimer = setTimeout(open, reconnectMs);
    };
  };

  open();

  return {
    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        ws?.close();
      } catch {
        // ignore
      }
    },
  };
}
