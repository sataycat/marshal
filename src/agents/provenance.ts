import type { AgentProvenance, InstalledAgent } from "./types.js";

export interface HistoricalAgentProvenance {
  installation_id: string | null;
  agent_id: string;
  agent_version: string;
  distribution: InstalledAgent["distribution"] | null;
  package_specifier: string | null;
  archive_identity: string | null;
  source: "registry" | "custom" | "legacy";
  registry_snapshot_fetched_at: string | null;
  integrity_status: InstalledAgent["integrity_status"] | "legacy";
  expected_digest: string | null;
  observed_digest: string | null;
}

export function historicalProvenance(agentId: string, agentVersion: string, provenance?: AgentProvenance | null, installationId?: string | null): HistoricalAgentProvenance {
  if (!provenance) return { installation_id: installationId ?? null, agent_id: agentId, agent_version: agentVersion, distribution: null, package_specifier: null, archive_identity: null, source: "legacy", registry_snapshot_fetched_at: null, integrity_status: "legacy", expected_digest: null, observed_digest: null };
  return { installation_id: installationId ?? null, agent_id: agentId, agent_version: agentVersion, distribution: provenance.distribution, package_specifier: provenance.package_specifier, archive_identity: provenance.archive_identity, source: provenance.source, registry_snapshot_fetched_at: provenance.registry_snapshot_fetched_at, integrity_status: provenance.integrity_status, expected_digest: provenance.expected_digest ?? null, observed_digest: provenance.observed_digest ?? null };
}
