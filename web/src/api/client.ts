import type {
  BusEvent,
  ChatMessage,
  ChatFileContent,
  ChatFileEntry,
  ChatThread,
  ChatAttachment,
  SpecMessage,
  TaskCard,
  TaskDetail,
  TaskStatus,
  PendingPermission,
  Repository,
  RegistryAgent,
  RegistryRefresh,
  RegistrySnapshot,
  InstalledAgent,
  InstallationOperation,
  AgentAuthenticationOperation,
  AcpEvent,
  WorkflowProfile,
  WorkflowRole,
  PermissionPolicy,
} from "../types";

export async function fetchRepositories(signal?: AbortSignal): Promise<{ repositories: Repository[]; selected_repository_id: string | null }> {
  const res = await fetch("/api/repositories", { signal });
  return jsonOrThrow(res);
}
export async function registerRepository(path: string): Promise<Repository> {
  const res = await fetch("/api/repositories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
  return (await jsonOrThrow<{ repository: Repository }>(res)).repository;
}
export async function selectRepository(id: string): Promise<Repository> {
  const res = await fetch(`/api/repositories/${encodeURIComponent(id)}/select`, { method: "POST" });
  return (await jsonOrThrow<{ repository: Repository }>(res)).repository;
}
export async function removeRepository(id: string): Promise<void> {
  const res = await fetch(`/api/repositories/${encodeURIComponent(id)}`, { method: "DELETE" });
  await jsonOrThrow(res);
}

export interface WorkflowProfileInput { name: string; permission_policy: PermissionPolicy; unattended_authorized: boolean; timeout_ms: number; max_retries: number; verification_commands: string[]; require_decorrelated_builder_validator: boolean; assignments: Array<{ role: WorkflowRole; agent_id: string; agent_version: string; model: string | null; mode: string | null }> }
export async function fetchWorkflowProfiles(repositoryId: string, signal?: AbortSignal): Promise<WorkflowProfile[]> { const res = await fetch(`/api/repositories/${encodeURIComponent(repositoryId)}/workflow-profiles`, { signal }); return (await jsonOrThrow<{ profiles: WorkflowProfile[] }>(res)).profiles; }
export async function createWorkflowProfile(repositoryId: string, input: WorkflowProfileInput): Promise<WorkflowProfile> { const res = await fetch(`/api/repositories/${encodeURIComponent(repositoryId)}/workflow-profiles`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }); return (await jsonOrThrow<{ profile: WorkflowProfile }>(res)).profile; }
export async function updateWorkflowProfile(repositoryId: string, id: string, input: WorkflowProfileInput): Promise<WorkflowProfile> { const res = await fetch(`/api/repositories/${encodeURIComponent(repositoryId)}/workflow-profiles/${encodeURIComponent(id)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }); return (await jsonOrThrow<{ profile: WorkflowProfile }>(res)).profile; }
export async function deleteWorkflowProfile(repositoryId: string, id: string): Promise<void> { const res = await fetch(`/api/repositories/${encodeURIComponent(repositoryId)}/workflow-profiles/${encodeURIComponent(id)}`, { method: "DELETE" }); await jsonOrThrow(res); }

export interface RegistryCatalogResponse {
  agents: RegistryAgent[];
  snapshot: RegistrySnapshot | null;
  refresh: RegistryRefresh | null;
  source: string;
}

export async function fetchRegistryCatalog(signal?: AbortSignal): Promise<RegistryCatalogResponse> {
  const res = await fetch("/api/registry/agents", { signal });
  return jsonOrThrow<RegistryCatalogResponse>(res);
}

export async function refreshRegistry(): Promise<RegistryRefresh> {
  const res = await fetch("/api/registry/refresh", { method: "POST" });
  return (await jsonOrThrow<{ refresh: RegistryRefresh }>(res)).refresh;
}

export async function fetchInstalledAgents(signal?: AbortSignal): Promise<InstalledAgent[]> {
  const res = await fetch("/api/agents", { signal });
  return (await jsonOrThrow<{ agents: InstalledAgent[] }>(res)).agents;
}

export async function installRegistryAgent(agentId: string, version: string): Promise<InstallationOperation> {
  const res = await fetch("/api/agents/install", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent_id: agentId, version }) });
  return (await jsonOrThrow<{ operation: InstallationOperation }>(res)).operation;
}

export async function fetchInstallationOperation(id: string, signal?: AbortSignal): Promise<InstallationOperation> {
  const res = await fetch(`/api/agents/operations/${encodeURIComponent(id)}`, { signal });
  return (await jsonOrThrow<{ operation: InstallationOperation }>(res)).operation;
}

export async function removeInstalledAgent(agentId: string, version: string): Promise<void> {
  const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}?version=${encodeURIComponent(version)}`, { method: "DELETE" });
  await jsonOrThrow(res);
}

export async function probeInstalledAgent(agentId: string, version: string): Promise<InstalledAgent> {
  const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/probe?version=${encodeURIComponent(version)}`, { method: "POST" });
  return (await jsonOrThrow<{ agent: InstalledAgent }>(res)).agent;
}
export async function authenticateInstalledAgent(agentId: string, version: string, methodId: string): Promise<AgentAuthenticationOperation> {
  const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/auth?version=${encodeURIComponent(version)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method_id: methodId }) });
  return (await jsonOrThrow<{ authentication: AgentAuthenticationOperation }>(res)).authentication;
}
export async function fetchAgentAuthentication(agentId: string, version: string, signal?: AbortSignal): Promise<{ authentication: AgentAuthenticationOperation | null }> {
  const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/auth?version=${encodeURIComponent(version)}`, { signal });
  return jsonOrThrow<{ authentication: AgentAuthenticationOperation | null }>(res);
}
export async function cancelAgentAuthentication(operationId: string): Promise<AgentAuthenticationOperation> {
  const res = await fetch(`/api/agents/auth/operations/${encodeURIComponent(operationId)}/cancel`, { method: "POST" });
  return (await jsonOrThrow<{ authentication: AgentAuthenticationOperation }>(res)).authentication;
}

export interface DiffStats {
  files: number;
  insertions: number;
  deletions: number;
}

export interface AuthStatus {
  enabled: boolean;
  authenticated: boolean;
}

export async function fetchAuthStatus(signal?: AbortSignal): Promise<AuthStatus> {
  const res = await fetch("/api/auth/status", { signal });
  return jsonOrThrow<AuthStatus>(res);
}

export async function login(password: string): Promise<AuthStatus> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  return jsonOrThrow<AuthStatus>(res);
}

export async function logout(): Promise<void> {
  const res = await fetch("/api/auth/logout", { method: "POST" });
  await jsonOrThrow<AuthStatus>(res);
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

export async function fetchTasks(signal?: AbortSignal): Promise<TaskCard[]> {
  const res = await fetch("/api/tasks", { signal });
  const body = await jsonOrThrow<{ tasks: TaskCard[] }>(res);
  return body.tasks;
}

export async function fetchTaskDetail(slug: string, signal?: AbortSignal): Promise<TaskDetail> {
  const res = await fetch(`/api/tasks/${encodeURIComponent(slug)}`, { signal });
  const body = await jsonOrThrow<{ task: TaskDetail }>(res);
  return body.task;
}

export class ApiError extends Error {
  code?: string;
  constructor(message: string, public readonly status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
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
  return new ApiError(message, res.status, envelope?.code);
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) throw await readError(res);
  return (await res.json()) as T;
}

export async function createTask(input: {
  title: string;
  spec_markdown?: string;
  repository_id?: string;
  workflow_profile_id?: string;
}): Promise<TaskDetail> {
  const res = await fetch("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await jsonOrThrow<{ task: TaskDetail }>(res);
  return body.task;
}

export interface SpecAuthorSessionEvidence { id: string; agent_id: string; agent_version: string; capabilities: unknown; assignment_config: unknown; acp_session_id: string | null; supervisor_session_id: string | null; status: string; operations: Array<{ id: number; operation: string; status: string; diagnostic: string | null; created_at: string }> }
export async function fetchSpecAuthorSessions(slug: string, signal?: AbortSignal): Promise<SpecAuthorSessionEvidence[]> { const res = await fetch(`/api/tasks/${encodeURIComponent(slug)}/spec-author-sessions`, { signal }); return (await jsonOrThrow<{ sessions: SpecAuthorSessionEvidence[] }>(res)).sessions; }

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

export async function fetchTaskDiff(slug: string, signal?: AbortSignal): Promise<DiffResponse> {
  const res = await fetch(`/api/tasks/${encodeURIComponent(slug)}/diff`, { signal });
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

export async function fetchSpecMessages(slug: string, signal?: AbortSignal): Promise<SpecMessage[]> {
  const res = await fetch(`/api/tasks/${encodeURIComponent(slug)}/spec-messages`, { signal });
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

export async function fetchChatThreads(includeArchived = false, signal?: AbortSignal): Promise<ChatThread[]> {
  const res = await fetch(`/api/threads${includeArchived ? "?archived=true" : ""}`, { signal });
  const body = await jsonOrThrow<{ threads: ChatThread[] }>(res);
  return body.threads;
}

export async function createChatThread(input: { agent_id: string; agent_version: string }): Promise<ChatThread> {
  const res = await fetch("/api/threads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await jsonOrThrow<{ thread: ChatThread }>(res);
  return body.thread;
}

export async function updateChatThread(id: string, input: { title?: string; status?: ChatThread["status"]; archived?: boolean; pinned?: boolean; scratch_markdown?: string }): Promise<ChatThread> {
  const res = await fetch(`/api/threads/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  return (await jsonOrThrow<{ thread: ChatThread }>(res)).thread;
}

export async function deleteChatThread(id: string): Promise<void> {
  const res = await fetch(`/api/threads/${encodeURIComponent(id)}`, { method: "DELETE" });
  await jsonOrThrow<{ deleted: boolean }>(res);
}

export async function fetchChatThread(id: string, signal?: AbortSignal): Promise<{ thread: ChatThread; messages: ChatMessage[]; events?: AcpEvent[] }> {
  const res = await fetch(`/api/threads/${encodeURIComponent(id)}`, { signal });
  return jsonOrThrow<{ thread: ChatThread; messages: ChatMessage[] }>(res);
}
export async function fetchChatEvents(id: string, signal?: AbortSignal): Promise<AcpEvent[]> {
  const res = await fetch(`/api/threads/${encodeURIComponent(id)}/events`, { signal });
  return (await jsonOrThrow<{ events: AcpEvent[] }>(res)).events;
}

export async function uploadChatAttachment(id: string, file: File): Promise<ChatAttachment> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`/api/threads/${encodeURIComponent(id)}/attachments`, { method: "POST", body: form });
  return (await jsonOrThrow<{ attachment: ChatAttachment }>(res)).attachment;
}

export async function fetchChatAttachments(id: string, signal?: AbortSignal): Promise<ChatAttachment[]> {
  const res = await fetch(`/api/threads/${encodeURIComponent(id)}/attachments`, { signal });
  return (await jsonOrThrow<{ attachments: ChatAttachment[] }>(res)).attachments;
}

export function chatAttachmentUrl(threadId: string, attachmentId: string): string {
  return `/api/threads/${encodeURIComponent(threadId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

export async function sendChatMessage(id: string, content: string, attachmentIds: string[] = []): Promise<{ userMessage: ChatMessage; assistantMessage: ChatMessage }> {
  const res = await fetch(`/api/threads/${encodeURIComponent(id)}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, attachment_ids: attachmentIds }),
  });
  return jsonOrThrow<{ userMessage: ChatMessage; assistantMessage: ChatMessage }>(res);
}

export async function cancelChatTurn(id: string): Promise<void> {
  const res = await fetch(`/api/threads/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  await jsonOrThrow<{ cancelled: boolean }>(res);
}

export async function fetchChatPermissions(id: string, signal?: AbortSignal): Promise<PendingPermission[]> {
  const res = await fetch(`/api/threads/${encodeURIComponent(id)}/permissions`, { signal });
  return (await jsonOrThrow<{ permissions: PendingPermission[] }>(res)).permissions;
}

export async function decideChatPermission(id: string, requestId: string, action: "approve" | "deny"): Promise<void> {
  const res = await fetch(`/api/threads/${encodeURIComponent(id)}/permissions/${encodeURIComponent(requestId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
  await jsonOrThrow<{ requestId: string; action: string }>(res);
}

export async function fetchChatFiles(id: string, signal?: AbortSignal): Promise<ChatFileEntry[]> {
  const res = await fetch(`/api/threads/${encodeURIComponent(id)}/files`, { signal });
  return (await jsonOrThrow<{ files: ChatFileEntry[] }>(res)).files;
}

export async function fetchChatFile(id: string, path: string, signal?: AbortSignal): Promise<ChatFileContent> {
  const res = await fetch(`/api/threads/${encodeURIComponent(id)}/files/content?path=${encodeURIComponent(path)}`, { signal });
  return (await jsonOrThrow<{ file: ChatFileContent }>(res)).file;
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
    options.onStatus?.("connecting");
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
