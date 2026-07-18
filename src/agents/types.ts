export type InstalledAgentStatus = "installing" | "installed" | "failed";
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
  command: "npx";
  args: string[];
}

export interface InstalledAgent {
  id: string;
  version: string;
  source: "registry";
  license: string;
  distribution: "npx";
  package_specifier: string;
  launch: AgentLaunchSpec;
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
