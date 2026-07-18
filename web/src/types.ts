export type TaskStatus = "backlog" | "ready" | "building" | "validating" | "review" | "done";

export interface Repository {
  id: string;
  path: string;
  name: string;
  created_at: string;
  updated_at: string;
  preferences: Record<string, unknown>;
  legacy_state: "preserved" | "none";
}

export interface RegistryDistribution {
  kind: "npx" | "uvx" | "binary";
  package?: string;
  platforms?: string[];
}

export interface RegistryAgent {
  id: string;
  name: string;
  version: string;
  description: string;
  repository?: string;
  website?: string;
  authors: string[];
  license: string;
  icon?: string;
  distributions: RegistryDistribution[];
}

export type InstalledAgentStatus = "installing" | "installed" | "failed";
export type AgentReadinessStatus = "unknown" | "probing" | "ready" | "authentication_required" | "failed";
export type AgentAuthenticationStatus = "authenticating" | "succeeded" | "failed" | "cancelled" | "interrupted";
export interface AgentCapabilities { prompt: { text: boolean; image: boolean; audio: boolean; embedded_context: boolean }; session: { close: boolean; list: boolean; load: boolean; fork: boolean; resume: boolean }; load_session: boolean; auth: { logout: boolean } }
export interface AgentAuthMethod { id: string; type: "agent" | "terminal" | "env_var"; name: string; description: string | null }
export interface InstalledAgent {
  id: string;
  version: string;
  source: "registry";
  license: string;
  distribution: "npx";
  package_specifier: string;
  launch: { command: "npx"; args: string[] };
  registry_snapshot_fetched_at: string;
  integrity_status: "not_applicable";
  status: InstalledAgentStatus;
  created_at: string;
  updated_at: string;
  failure: string | null;
  readiness_status: AgentReadinessStatus;
  readiness_error: string | null;
  protocol_version: number | null;
  capabilities: AgentCapabilities | null;
  auth_methods: AgentAuthMethod[];
  raw_initialize: Record<string, unknown> | null;
  probed_at: string | null;
}
export interface AgentAuthenticationOperation { id: string; agent_id: string; version: string; method_id: string; method_name: string; status: AgentAuthenticationStatus; started_at: string; finished_at: string | null; error: string | null }
export interface InstallationOperation {
  id: string;
  agent_id: string;
  version: string;
  package_specifier: string;
  status: InstalledAgentStatus;
  started_at: string;
  finished_at: string | null;
  error: string | null;
}

export interface RegistrySnapshot {
  version: string;
  agents: RegistryAgent[];
  source: string;
  fetched_at: string;
}

export type RegistryRefreshStatus = "never" | "running" | "succeeded" | "failed";

export interface RegistryRefresh {
  id: string;
  status: RegistryRefreshStatus;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  snapshot_fetched_at: string | null;
}

export interface TaskCard {
  id: number;
  slug: string;
  title: string;
  status: TaskStatus;
  retry_count: number;
  created_at: string;
  updated_at: string;
}

export interface TaskDetail extends TaskCard {
  spec_markdown: string;
  last_failure: string | null;
}

export interface BusEvent<P = unknown> {
  type: string;
  payload: P;
  timestamp: string;
}

export interface ConnectedPayload {
  tasks: TaskCard[];
}

export type SpecMessageRole = "user" | "assistant";

export interface SpecMessage {
  id: number;
  task_id: number;
  role: SpecMessageRole;
  content: string;
  created_at: string;
}

export interface SpecMessagePayload {
  taskSlug: string;
  message: SpecMessage;
}

export type ChatThreadStatus = "draft" | "active" | "closed" | "error";
export type ChatMessageRole = "user" | "assistant";

export interface ChatThread {
  id: string;
  repository_id?: string | null;
  repo_root: string;
  cwd: string;
  agent_id: string;
  agent_version: string;
  title: string;
  status: ChatThreadStatus;
  archived: boolean;
  pinned: boolean;
  task_slug: string | null;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
  scratch_markdown: string;
}

export interface ChatMessage {
  id: number;
  thread_id: string;
  role: ChatMessageRole;
  content: string;
  created_at: string;
  attachment_ids: string[];
}
export interface AcpEvent {
  id: number;
  session_id: string;
  prompt_id: string | null;
  seq: number;
  type: string;
  normalized: unknown;
  raw_payload: unknown;
  created_at: string;
}

export interface ChatAttachment {
  id: string;
  thread_id: string;
  filename: string;
  mime_type: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  byte_size: number;
  created_at: string;
}

export interface ChatFileEntry {
  path: string;
  type: "file" | "directory";
  changed: boolean;
  touched: boolean;
}

export interface ChatFileContent {
  path: string;
  content: string;
  truncated: boolean;
  bytes: number;
}

export interface ThreadPayload {
  thread: ChatThread;
}

export interface ThreadMessagePayload {
  threadId: string;
  message: ChatMessage;
}

export interface ThreadDeletedPayload {
  id: string;
}

export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";
export interface PermissionOption {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}
export interface PendingPermission {
  requestId: string;
  sessionId: string;
  threadId: string;
  tool: string;
  kind?: string | null;
  rawInput?: unknown;
  options: PermissionOption[];
}
