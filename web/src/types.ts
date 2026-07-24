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
export interface DirectorySuggestion {
  name: string;
  path: string;
  is_git: boolean;
}

export type WorkflowRole = "specAuthor" | "builder" | "validator";
export type PermissionPolicy =
  | "reject_all"
  | "allow_reads_ask_writes"
  | "allow_workspace"
  | "unattended_allow_all";
export interface AgentAssignment {
  id: string;
  profile_id: string;
  role: WorkflowRole;
  agent_id: string;
  agent_version: string;
  model: string | null;
  mode: string | null;
  created_at: string;
  updated_at: string;
}
export interface WorkflowProfile {
  id: string;
  repository_id?: string;
  name: string;
  permission_policy: PermissionPolicy;
  unattended_authorized: boolean;
  timeout_ms: number;
  max_retries: number;
  verification_commands: string[];
  require_decorrelated_builder_validator: boolean;
  assignments: AgentAssignment[];
  created_at: string;
  updated_at: string;
}

export interface RegistryDistribution {
  kind: "npx" | "uvx" | "binary";
  package?: string;
  platforms?: string[];
  args?: string[];
  platform?: string;
  archive_url?: string;
  archive_format?: "tar.gz" | "tgz" | "zip";
  checksum?: string;
  executable?: string;
  env?: Record<string, string>;
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

export type InstalledAgentStatus = "installing" | "installed" | "failed" | "interrupted";
export type InstallationPhase =
  | "resolving"
  | "downloading"
  | "verifying"
  | "extracting"
  | "publishing"
  | "completed"
  | "failed"
  | "interrupted";
export type AgentActivationStatus =
  | "not_started"
  | "checking"
  | "authentication_required"
  | "ready"
  | "failed"
  | "interrupted";
export type AgentReadinessStatus =
  | "unknown"
  | "probing"
  | "ready"
  | "authentication_required"
  | "failed";
export type AgentAuthenticationStatus =
  | "authenticating"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";
export interface AgentCapabilities {
  prompt: { text: boolean; image: boolean; audio: boolean; embedded_context: boolean };
  session: { close: boolean; list: boolean; load: boolean; fork: boolean; resume: boolean };
  load_session: boolean;
  auth: { logout: boolean };
}
export interface AgentAuthMethod {
  id: string;
  type: "agent" | "terminal" | "env_var" | string;
  name: string;
  description: string | null;
  vars: Array<{
    name: string;
    label: string | null;
    secret: boolean;
    optional: boolean;
    meta: Record<string, unknown> | null;
    raw: Record<string, unknown>;
  }>;
  link: string | null;
  args: string[];
  env: Record<string, string>;
  meta: Record<string, unknown> | null;
  raw: Record<string, unknown>;
}
export type AcpFailureKind =
  | "authentication_required"
  | "cancelled"
  | "resource_not_found"
  | "protocol_incompatible"
  | "process_start_failed"
  | "timeout"
  | "agent_internal_error";
export interface StructuredAcpError {
  kind: AcpFailureKind;
  message: string;
  protocol_code: number | null;
  data: unknown;
}
export interface InstalledAgent {
  id: string;
  version: string;
  source: "registry";
  license: string;
  distribution: "npx" | "uvx" | "binary";
  package_specifier: string | null;
  launch: { command: string; args: string[]; env?: Record<string, string> };
  registry_snapshot_fetched_at: string;
  integrity_status: "verified" | "unverified" | "mismatch" | "not_applicable" | "unknown";
  status: InstalledAgentStatus;
  created_at: string;
  updated_at: string;
  failure: string | null;
  readiness_status: AgentReadinessStatus;
  readiness_error: string | null;
  readiness_failure: StructuredAcpError | null;
  protocol_version: number | null;
  capabilities: AgentCapabilities | null;
  auth_methods: AgentAuthMethod[];
  raw_initialize: Record<string, unknown> | null;
  probed_at: string | null;
  installation_id: string;
  installation_root: string;
  provenance: {
    exact_version: string;
    distribution: "binary" | "npx" | "uvx";
    source: "registry" | "custom";
    package_specifier: string | null;
    archive_identity: string | null;
    registry_snapshot_fetched_at: string | null;
    installation_root: string;
    integrity_status: string;
  };
  is_default: boolean;
}
export interface AgentAuthenticationOperation {
  id: string;
  agent_id: string;
  version: string;
  installation_id: string;
  method_id: string;
  method_name: string;
  method_type: string;
  status: AgentAuthenticationStatus;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  failure: StructuredAcpError | null;
  terminal_exit_code: number | null;
  terminal_signal: number | null;
  terminal_output_truncated: boolean;
  terminal_last_activity_at: string | null;
  terminal_diagnostic: { code: string; message: string; action: string } | null;
}
export interface TerminalAuthSnapshot {
  operation: AgentAuthenticationOperation;
  phase: "running" | "reprobing" | "completed";
  output: string;
  output_truncated: boolean;
  connected: boolean;
  host: string;
}
export interface InstallationOperation {
  id: string;
  agent_id: string;
  version: string;
  package_specifier: string | null;
  distribution: "npx" | "uvx" | "binary";
  installation_id: string;
  phase: InstallationPhase;
  status: InstalledAgentStatus;
  activation_status: AgentActivationStatus;
  activation_started_at: string | null;
  activation_finished_at: string | null;
  activation_error: string | null;
  activation_error_code: string | null;
  activation_diagnostic: {
    message: string;
    action: string;
    details?: Record<string, unknown>;
  } | null;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  error_code: string | null;
  diagnostic: { message: string; action: string; details?: Record<string, unknown> } | null;
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
export interface DiagnosticIssue {
  code: string;
  message: string;
  action: string;
  severity: "error" | "warning";
}
export interface DiagnosticsResponse {
  daemon: { status: string; version: string; host: string | null };
  repository: { selected: Repository | null; registered_count: number; root: string | null };
  registry: { snapshot: RegistrySnapshot | null; refresh: RegistryRefresh | null };
  agents: InstalledAgent[];
  issues: DiagnosticIssue[];
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
  repository_id?: string | null;
  workflow_profile_id?: string | null;
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
  prompt_status?: "authentication_required" | null;
  failure?: StructuredAcpError | null;
}
export interface WorkflowRun {
  id: number;
  task_id: number;
  role: "builder" | "validator";
  agent_id: string;
  agent_version?: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  error: string | null;
  failure: StructuredAcpError | null;
  auth_recovery_resolved_at: string | null;
  superseded_by_run_id: number | null;
}

export interface SpecMessagePayload {
  taskSlug: string;
  message: SpecMessage;
}

export type ChatThreadStatus = "active" | "authentication_required" | "closed" | "error";
export type ChatMessageRole = "user" | "assistant";

export interface SessionConfigValue {
  value: string;
  name: string;
  description?: string | null;
}
export interface SessionConfigGroup {
  group: string;
  name: string;
  options: SessionConfigValue[];
}
export type SessionConfigOption = {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
} & (
  | { type: "select"; currentValue: string; options: SessionConfigValue[] | SessionConfigGroup[] }
  | { type: "boolean"; currentValue: boolean }
);
export interface SessionModeState {
  currentModeId: string;
  availableModes: Array<{ id: string; name: string; description?: string | null }>;
}

export interface ChatThread {
  id: string;
  repository_id?: string;
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
  session_config_options: SessionConfigOption[];
  session_modes: SessionModeState | null;
  session_initialized: boolean;
  agent_provenance?: { installation_id?: string | null };
  failure?: StructuredAcpError | null;
}

export interface ChatMessage {
  id: number;
  repository_id?: string;
  thread_id: string;
  role: ChatMessageRole;
  content: string;
  created_at: string;
  attachment_ids: string[];
  prompt_status?: "authentication_required" | null;
  failure?: StructuredAcpError | null;
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
export type PermissionRequestStatus =
  | "pending"
  | "approved"
  | "denied"
  | "cancelled"
  | "stale"
  | "interrupted";

export interface ChatAttachment {
  id: string;
  repository_id: string;
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
  repository_id?: string;
  requestId: string;
  sessionId: string;
  threadId: string;
  tool: string;
  kind?: string | null;
  rawInput?: unknown;
  options: PermissionOption[];
  id?: string;
  session_id?: string;
  thread_id?: string;
  request_id?: string;
  status?: PermissionRequestStatus;
  selected_option_id?: string | null;
  decision_action?: string | null;
  diagnostic?: string | null;
  created_at?: string;
  updated_at?: string;
  resolved_at?: string | null;
}
