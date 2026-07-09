import type { BusEvent, TaskCard, TaskDetail, TaskStatus } from "../types";

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

export interface ApiError extends Error {
  code?: string;
  status: number;
}

interface ErrorEnvelope {
  error: string;
  code?: string;
}

async function readError(res: Response): Promise<ApiError> {
  let envelope: ErrorEnvelope | null = null;
  try {
    envelope = (await res.json()) as ErrorEnvelope;
  } catch {
    envelope = null;
  }
  const message = envelope?.error ?? `Request failed: ${res.status}`;
  const err = new Error(message) as ApiError;
  err.status = res.status;
  if (envelope?.code !== undefined) err.code = envelope.code;
  return err;
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) throw await readError(res);
  return (await res.json()) as T;
}

export async function createTask(input: {
  title: string;
  spec_markdown?: string;
}): Promise<TaskDetail> {
  const res = await fetch("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await jsonOrThrow<{ task: TaskDetail }>(res);
  return body.task;
}

export async function freezeTask(
  slug: string,
  specMarkdown?: string,
): Promise<TaskDetail> {
  const body: Record<string, string> = {};
  if (specMarkdown !== undefined) body.specMarkdown = specMarkdown;
  const res = await fetch(`/api/tasks/${encodeURIComponent(slug)}/ready`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await jsonOrThrow<{ task: TaskDetail }>(res);
  return json.task;
}

export async function transitionTask(
  slug: string,
  to: TaskStatus,
): Promise<TaskDetail> {
  const res = await fetch(`/api/tasks/${encodeURIComponent(slug)}/transition`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to }),
  });
  const json = await jsonOrThrow<{ task: TaskDetail }>(res);
  return json.task;
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
