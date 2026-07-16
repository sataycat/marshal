import type {
  BusEvent,
  ChatMessage,
  ChatThread,
  SpecMessage,
  TaskCard,
  TaskDetail,
  TaskStatus,
} from "../types";

export interface DiffStats {
  files: number;
  insertions: number;
  deletions: number;
}

export interface DiffResponse {
  diff: string;
  stats: DiffStats;
}

export interface MergeResponse {
  merged: boolean;
  commitSha: string;
  task: TaskDetail;
}

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

export async function freezeTask(slug: string, specMarkdown?: string): Promise<TaskDetail> {
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

export async function transitionTask(slug: string, to: TaskStatus): Promise<TaskDetail> {
  const res = await fetch(`/api/tasks/${encodeURIComponent(slug)}/transition`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to }),
  });
  const json = await jsonOrThrow<{ task: TaskDetail }>(res);
  return json.task;
}

export async function fetchTaskDiff(slug: string): Promise<DiffResponse> {
  const res = await fetch(`/api/tasks/${encodeURIComponent(slug)}/diff`);
  return jsonOrThrow<DiffResponse>(res);
}

export async function mergeTask(slug: string): Promise<MergeResponse> {
  const res = await fetch(`/api/tasks/${encodeURIComponent(slug)}/merge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  return jsonOrThrow<MergeResponse>(res);
}

export async function fetchSpecMessages(slug: string): Promise<SpecMessage[]> {
  const res = await fetch(`/api/tasks/${encodeURIComponent(slug)}/spec-messages`);
  const body = await jsonOrThrow<{ messages: SpecMessage[] }>(res);
  return body.messages;
}

export interface SendSpecMessageResponse {
  userMessage: SpecMessage;
  assistantMessage: SpecMessage;
}

export async function sendSpecMessage(
  slug: string,
  content: string,
): Promise<SendSpecMessageResponse> {
  const res = await fetch(`/api/tasks/${encodeURIComponent(slug)}/spec-messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  return jsonOrThrow<SendSpecMessageResponse>(res);
}

export async function updateTaskSpec(slug: string, specMarkdown: string): Promise<TaskDetail> {
  const res = await fetch(`/api/tasks/${encodeURIComponent(slug)}/spec`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spec_markdown: specMarkdown }),
  });
  const body = await jsonOrThrow<{ task: TaskDetail }>(res);
  return body.task;
}

export async function fetchChatThreads(includeArchived = false): Promise<ChatThread[]> {
  const res = await fetch(`/api/threads${includeArchived ? "?archived=true" : ""}`);
  const body = await jsonOrThrow<{ threads: ChatThread[] }>(res);
  return body.threads;
}

export async function fetchChatAgents(): Promise<string[]> {
  const res = await fetch("/api/chat-agents");
  const body = await jsonOrThrow<{ agents: string[] }>(res);
  return body.agents;
}

export async function createChatThread(input: { agent_id: string }): Promise<ChatThread> {
  const res = await fetch("/api/threads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await jsonOrThrow<{ thread: ChatThread }>(res);
  return body.thread;
}

export async function updateChatThread(id: string, input: { title?: string; status?: ChatThread["status"]; archived?: boolean; pinned?: boolean }): Promise<ChatThread> {
  const res = await fetch(`/api/threads/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  return (await jsonOrThrow<{ thread: ChatThread }>(res)).thread;
}

export async function deleteChatThread(id: string): Promise<void> {
  const res = await fetch(`/api/threads/${encodeURIComponent(id)}`, { method: "DELETE" });
  await jsonOrThrow<{ deleted: boolean }>(res);
}

export async function fetchChatThread(id: string): Promise<{ thread: ChatThread; messages: ChatMessage[] }> {
  const res = await fetch(`/api/threads/${encodeURIComponent(id)}`);
  return jsonOrThrow<{ thread: ChatThread; messages: ChatMessage[] }>(res);
}

export async function sendChatMessage(id: string, content: string): Promise<{ userMessage: ChatMessage; assistantMessage: ChatMessage }> {
  const res = await fetch(`/api/threads/${encodeURIComponent(id)}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  return jsonOrThrow<{ userMessage: ChatMessage; assistantMessage: ChatMessage }>(res);
}

export async function cancelChatTurn(id: string): Promise<void> {
  const res = await fetch(`/api/threads/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  await jsonOrThrow<{ cancelled: boolean }>(res);
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
