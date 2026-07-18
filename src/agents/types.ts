export type InstalledAgentStatus = "installing" | "installed" | "failed";

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
