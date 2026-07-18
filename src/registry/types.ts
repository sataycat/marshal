export const PUBLIC_REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

export interface RegistryDistribution {
  kind: "npx" | "uvx" | "binary";
  package?: string;
  args?: string[];
  platforms?: string[];
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

export interface RegistryCatalog {
  snapshot: RegistrySnapshot | null;
  refresh: RegistryRefresh | null;
}
