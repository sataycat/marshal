export type InstalledAgentStatus = "installing" | "installed" | "failed" | "interrupted";
export type InstallationPhase = "resolving" | "downloading" | "verifying" | "extracting" | "publishing" | "completed" | "failed" | "interrupted";
export type AgentReadinessStatus = "unknown" | "probing" | "ready" | "authentication_required" | "failed";
export type AgentAuthenticationStatus = "authenticating" | "succeeded" | "failed" | "cancelled" | "interrupted";

export interface AgentCapabilities {
  prompt: { text: boolean; image: boolean; audio: boolean; embedded_context: boolean };
  session: { close: boolean; list: boolean; load: boolean; fork: boolean; resume: boolean };
  load_session: boolean;
  auth: { logout: boolean };
}

export interface AgentAuthMethod {
  id: string;
  type: "agent" | "terminal" | "env_var";
  name: string;
  description: string | null;
}

export interface AgentLaunchSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export type AgentDistribution = "binary" | "npx" | "uvx";
export type AgentIntegrityStatus = "verified" | "unverified" | "mismatch" | "not_applicable" | "unknown";
export interface AgentProvenance {
  exact_version: string;
  distribution: AgentDistribution;
  source: "registry" | "custom";
  package_specifier: string | null;
  archive_identity: string | null;
  registry_snapshot_fetched_at: string | null;
  installation_root: string;
  integrity_status: AgentIntegrityStatus;
  expected_digest?: string | null;
  observed_digest?: string | null;
}
export function validateAgentLaunchSpec(value: unknown): AgentLaunchSpec {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Installed agent launch specification is invalid");
  const launch = value as Record<string, unknown>;
  if (typeof launch.command !== "string" || launch.command.trim() === "" || launch.command.includes("\0")) throw new Error("Installed agent launch command is invalid");
  if (!Array.isArray(launch.args) || launch.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) throw new Error("Installed agent launch arguments are invalid");
  return { command: launch.command, args: [...launch.args] as string[], ...(launch.env ? { env: { ...(launch.env as Record<string, string>) } } : {}) };
}

export interface InstalledAgent {
  id: string;
  version: string;
  source: "registry" | "custom";
  license: string;
  distribution: AgentDistribution;
  package_specifier: string | null;
  launch: AgentLaunchSpec;
  provenance: AgentProvenance;
  installation_id: string;
  installation_root: string;
  registry_snapshot_fetched_at: string | null;
  integrity_status: AgentIntegrityStatus;
  expected_digest?: string | null;
  observed_digest?: string | null;
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
  is_default: boolean;
}

export interface InstallationOperation {
  id: string;
  agent_id: string;
  version: string;
  package_specifier: string | null;
  distribution: AgentDistribution;
  installation_id: string;
  phase: InstallationPhase;
  temporary_root: string | null;
  published_root: string | null;
  recovery_metadata: Record<string, unknown> | null;
  status: InstalledAgentStatus;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  error_code: string | null;
  diagnostic: { message: string; action: string; details?: Record<string, unknown> } | null;
}

export interface AgentDefaultSelection { agent_id: string; installation_id: string; distribution: AgentDistribution; version: string; updated_at: string }

export interface AgentAuthenticationOperation {
  id: string;
  agent_id: string;
  version: string;
  method_id: string;
  method_name: string;
  status: AgentAuthenticationStatus;
  started_at: string;
  finished_at: string | null;
  error: string | null;
}
