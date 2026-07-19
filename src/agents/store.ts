import { openMachineDb } from "../storage/machine.js";
import { validateAgentLaunchSpec, type AgentAuthenticationOperation, type InstalledAgent, type InstallationOperation, type InstallationPhase } from "./types.js";
import { existsSync, readFileSync, rmSync } from "node:fs";

function tables(machineDir?: string) {
  const db = openMachineDb(machineDir);
  db.exec(`
    CREATE TABLE IF NOT EXISTS installed_agents (
      id TEXT NOT NULL,
      version TEXT NOT NULL,
      source TEXT NOT NULL,
      license TEXT NOT NULL,
      distribution TEXT NOT NULL,
      package_specifier TEXT NOT NULL,
      launch TEXT NOT NULL,
      registry_snapshot_fetched_at TEXT NOT NULL,
      integrity_status TEXT NOT NULL,
      expected_digest TEXT,
      observed_digest TEXT,
      installation_id TEXT,
      provenance TEXT,
      installation_root TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      failure TEXT,
      PRIMARY KEY (id, version)
    );
    CREATE TABLE IF NOT EXISTS installation_operations (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      version TEXT NOT NULL,
      package_specifier TEXT NOT NULL,
      distribution TEXT NOT NULL DEFAULT 'npx',
      installation_id TEXT NOT NULL DEFAULT '',
      phase TEXT NOT NULL DEFAULT 'resolving',
      temporary_root TEXT,
      published_root TEXT,
      recovery_metadata TEXT,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS agent_authentication_operations (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      version TEXT NOT NULL,
      method_id TEXT NOT NULL,
      method_name TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      error TEXT
    );
  `);
  for (const statement of [
    "ALTER TABLE installed_agents ADD COLUMN installation_id TEXT",
    "ALTER TABLE installed_agents ADD COLUMN provenance TEXT",
    "ALTER TABLE installed_agents ADD COLUMN installation_root TEXT",
    "ALTER TABLE installed_agents ADD COLUMN readiness_status TEXT NOT NULL DEFAULT 'unknown'",
    "ALTER TABLE installed_agents ADD COLUMN readiness_error TEXT",
    "ALTER TABLE installed_agents ADD COLUMN protocol_version INTEGER",
    "ALTER TABLE installed_agents ADD COLUMN capabilities TEXT",
    "ALTER TABLE installed_agents ADD COLUMN auth_methods TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE installed_agents ADD COLUMN raw_initialize TEXT",
    "ALTER TABLE installed_agents ADD COLUMN probed_at TEXT",
    "ALTER TABLE installed_agents ADD COLUMN expected_digest TEXT",
    "ALTER TABLE installed_agents ADD COLUMN observed_digest TEXT",
    "ALTER TABLE installation_operations ADD COLUMN distribution TEXT NOT NULL DEFAULT 'npx'",
    "ALTER TABLE installation_operations ADD COLUMN installation_id TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE installation_operations ADD COLUMN phase TEXT NOT NULL DEFAULT 'resolving'",
    "ALTER TABLE installation_operations ADD COLUMN temporary_root TEXT",
    "ALTER TABLE installation_operations ADD COLUMN published_root TEXT",
    "ALTER TABLE installation_operations ADD COLUMN recovery_metadata TEXT",
  ]) { try { db.exec(statement); } catch (error) { if (!(error instanceof Error) || !error.message.includes("duplicate column name")) throw error; } }
  return db;
}

export function interruptActiveAgentAuthentications(machineDir?: string): void {
  const db = tables(machineDir);
  db.prepare("UPDATE agent_authentication_operations SET status = 'interrupted', finished_at = ?, error = COALESCE(error, 'Authentication was interrupted by a daemon restart') WHERE status = 'authenticating'").run(new Date().toISOString());
}

function agent(row: Record<string, unknown>): InstalledAgent {
  const launch = validateAgentLaunchSpec(JSON.parse(String(row.launch)));
  const distribution = String(row.distribution) as InstalledAgent["distribution"];
  const installationRoot = String(row.installation_root ?? "");
  const provenance = row.provenance ? JSON.parse(String(row.provenance)) : {
    exact_version: String(row.version), distribution, source: "registry", package_specifier: row.package_specifier == null ? null : String(row.package_specifier), archive_identity: null,
    registry_snapshot_fetched_at: row.registry_snapshot_fetched_at == null ? null : String(row.registry_snapshot_fetched_at), installation_root: installationRoot, integrity_status: String(row.integrity_status),
    expected_digest: row.expected_digest == null ? null : String(row.expected_digest), observed_digest: row.observed_digest == null ? null : String(row.observed_digest),
  };
  return {
    id: String(row.id), version: String(row.version), source: provenance.source, license: String(row.license),
    distribution, package_specifier: row.package_specifier == null ? null : String(row.package_specifier), launch, provenance,
    installation_id: String(row.installation_id ?? `${row.id}@${row.version}`), installation_root: installationRoot,
    registry_snapshot_fetched_at: row.registry_snapshot_fetched_at == null ? null : String(row.registry_snapshot_fetched_at), integrity_status: String(row.integrity_status) as InstalledAgent["integrity_status"],
    status: String(row.status) as InstalledAgent["status"], created_at: String(row.created_at), updated_at: String(row.updated_at),
    failure: row.failure === null || row.failure === undefined ? null : String(row.failure),
    readiness_status: String(row.readiness_status ?? "unknown") as InstalledAgent["readiness_status"], readiness_error: row.readiness_error ? String(row.readiness_error) : null,
    protocol_version: row.protocol_version == null ? null : Number(row.protocol_version), capabilities: row.capabilities ? JSON.parse(String(row.capabilities)) : null,
    auth_methods: row.auth_methods ? JSON.parse(String(row.auth_methods)) : [], raw_initialize: row.raw_initialize ? JSON.parse(String(row.raw_initialize)) : null, probed_at: row.probed_at ? String(row.probed_at) : null,
  };
}

function operation(row: Record<string, unknown>): InstallationOperation {
  return { id: String(row.id), agent_id: String(row.agent_id), version: String(row.version), package_specifier: row.package_specifier == null ? null : String(row.package_specifier), distribution: String(row.distribution ?? "npx") as InstallationOperation["distribution"], installation_id: String(row.installation_id ?? ""), phase: String(row.phase ?? row.status) as InstallationPhase, temporary_root: row.temporary_root ? String(row.temporary_root) : null, published_root: row.published_root ? String(row.published_root) : null, recovery_metadata: row.recovery_metadata ? JSON.parse(String(row.recovery_metadata)) : null, status: String(row.status) as InstallationOperation["status"], started_at: String(row.started_at), finished_at: row.finished_at ? String(row.finished_at) : null, error: row.error ? String(row.error) : null };
}

function authenticationOperation(row: Record<string, unknown>): AgentAuthenticationOperation {
  return { id: String(row.id), agent_id: String(row.agent_id), version: String(row.version), method_id: String(row.method_id), method_name: String(row.method_name), status: String(row.status) as AgentAuthenticationOperation["status"], started_at: String(row.started_at), finished_at: row.finished_at ? String(row.finished_at) : null, error: row.error ? String(row.error) : null };
}

export function listInstalledAgents(machineDir?: string): InstalledAgent[] {
  const db = tables(machineDir);
  return (db.prepare("SELECT * FROM installed_agents ORDER BY id, version").all() as Record<string, unknown>[]).map(agent);
}

export function getInstalledAgent(id: string, version: string, machineDir?: string): InstalledAgent | undefined {
  const db = tables(machineDir);
  const row = db.prepare("SELECT * FROM installed_agents WHERE id = ? AND version = ?").get(id, version) as Record<string, unknown> | undefined;
  return row ? agent(row) : undefined;
}

export function getLatestInstallationOperation(id: string, version: string, machineDir?: string): InstallationOperation | undefined {
  const db = tables(machineDir);
  const row = db.prepare("SELECT * FROM installation_operations WHERE agent_id = ? AND version = ? ORDER BY started_at DESC LIMIT 1").get(id, version) as Record<string, unknown> | undefined;
  return row ? operation(row) : undefined;
}

export function createInstallation(input: Omit<InstalledAgent, "created_at" | "updated_at" | "failure" | "provenance" | "installation_id" | "installation_root"> & Partial<Pick<InstalledAgent, "provenance" | "installation_id" | "installation_root">>, operationId: string, machineDir?: string, metadata: Partial<Pick<InstallationOperation, "phase" | "temporary_root" | "published_root" | "recovery_metadata">> = {}): InstallationOperation {
  const db = tables(machineDir);
  const now = new Date().toISOString();
  const installationRoot = input.installation_root ?? "";
  const installationId = input.installation_id ?? `${input.id}@${input.version}`;
  const provenance = input.provenance ?? { exact_version: input.version, distribution: input.distribution, source: input.source, package_specifier: input.package_specifier, archive_identity: null, registry_snapshot_fetched_at: input.registry_snapshot_fetched_at, installation_root: installationRoot, integrity_status: input.integrity_status };
   const op: InstallationOperation = { id: operationId, agent_id: input.id, version: input.version, package_specifier: input.package_specifier, distribution: input.distribution, installation_id: installationId, phase: metadata.phase ?? "resolving", temporary_root: metadata.temporary_root ?? null, published_root: metadata.published_root ?? installationRoot, recovery_metadata: metadata.recovery_metadata ?? null, status: "installing", started_at: now, finished_at: null, error: null };
  db.transaction(() => {
     db.prepare("INSERT INTO installed_agents (id, version, source, license, distribution, package_specifier, launch, registry_snapshot_fetched_at, integrity_status, expected_digest, observed_digest, installation_id, provenance, installation_root, status, created_at, updated_at, failure) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(id, version) DO UPDATE SET package_specifier = excluded.package_specifier, launch = excluded.launch, registry_snapshot_fetched_at = excluded.registry_snapshot_fetched_at, integrity_status = excluded.integrity_status, expected_digest = excluded.expected_digest, observed_digest = excluded.observed_digest, provenance = excluded.provenance, installation_root = excluded.installation_root, license = excluded.license, status = 'installing', updated_at = excluded.updated_at, failure = NULL").run(input.id, input.version, input.source, input.license, input.distribution, input.package_specifier, JSON.stringify(input.launch), input.registry_snapshot_fetched_at ?? "unknown", input.integrity_status, (input.provenance as { expected_digest?: string | null } | undefined)?.expected_digest ?? null, (input.provenance as { observed_digest?: string | null } | undefined)?.observed_digest ?? null, installationId, JSON.stringify(provenance), installationRoot, "installing", now, now);
     db.prepare("INSERT INTO installation_operations (id, agent_id, version, package_specifier, distribution, installation_id, phase, temporary_root, published_root, recovery_metadata, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'installing', ?)").run(op.id, op.agent_id, op.version, op.package_specifier, op.distribution, op.installation_id, op.phase, op.temporary_root, op.published_root, op.recovery_metadata ? JSON.stringify(op.recovery_metadata) : null, op.started_at);
  })();
  return op;
}

export function resolveInstalledAgentLaunch(id: string, version: string, machineDir?: string): InstalledAgent["launch"] {
  const installed = getInstalledAgent(id, version, machineDir);
  if (!installed || installed.status !== "installed") throw new Error(`Installed agent ${id}@${version} is not available`);
  return validateAgentLaunchSpec(installed.launch);
}

export function updateInstallationPhase(operationId: string, phase: InstallationPhase, metadata: Partial<Pick<InstallationOperation, "temporary_root" | "published_root" | "recovery_metadata">> = {}, machineDir?: string): void {
  const db = tables(machineDir);
  db.prepare("UPDATE installation_operations SET phase = ?, temporary_root = COALESCE(?, temporary_root), published_root = COALESCE(?, published_root), recovery_metadata = COALESCE(?, recovery_metadata) WHERE id = ?").run(phase, metadata.temporary_root ?? null, metadata.published_root ?? null, metadata.recovery_metadata ? JSON.stringify(metadata.recovery_metadata) : null, operationId);
}

export function finishInstallation(operationId: string, status: "installed" | "failed" | "interrupted", error: string | null, machineDir?: string): InstallationOperation {
  const db = tables(machineDir);
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare("UPDATE installation_operations SET status = ?, phase = ?, finished_at = ?, error = ? WHERE id = ?").run(status, status === "installed" ? "completed" : status, now, error, operationId);
    db.prepare("UPDATE installed_agents SET status = ?, updated_at = ?, failure = ? WHERE id = (SELECT agent_id FROM installation_operations WHERE id = ?) AND version = (SELECT version FROM installation_operations WHERE id = ?)").run(status, now, error, operationId, operationId);
  })();
  return getInstallationOperation(operationId, machineDir)!;
}

export function reconcileInstallationOperations(machineDir?: string): void {
  const db = tables(machineDir);
  const rows = db.prepare("SELECT * FROM installation_operations WHERE status = 'installing'").all() as Record<string, unknown>[];
  for (const row of rows) {
    const temporary = row.temporary_root ? String(row.temporary_root) : null;
    const published = row.published_root ? String(row.published_root) : null;
    const manifest = published && existsSync(`${published}/manifest.json`);
    if (manifest) {
      try { JSON.parse(readFileSync(`${published}/manifest.json`, "utf8")); finishInstallation(String(row.id), "installed", null, machineDir); }
      catch { finishInstallation(String(row.id), "failed", "Published installation manifest is invalid", machineDir); }
    } else {
      finishInstallation(String(row.id), "interrupted", "Installation was interrupted before publication", machineDir);
    }
    if (temporary && existsSync(temporary)) { try { rmSync(temporary, { recursive: true, force: true }); } catch { /* best effort cleanup */ } }
  }
}

export function getInstallationByIdentity(agentId: string, version: string, distribution: string, installationId: string, machineDir?: string): InstallationOperation | undefined {
  const db = tables(machineDir);
  const row = db.prepare("SELECT * FROM installation_operations WHERE agent_id = ? AND version = ? AND distribution = ? AND installation_id = ? ORDER BY started_at DESC LIMIT 1").get(agentId, version, distribution, installationId) as Record<string, unknown> | undefined;
  return row ? operation(row) : undefined;
}

export function persistInstallationIntegrity(operationId: string, expected: string | null, observed: string, status: "verified" | "unverified" | "mismatch", machineDir?: string): void {
  const db = tables(machineDir);
  db.prepare("UPDATE installed_agents SET expected_digest = ?, observed_digest = ?, integrity_status = ?, provenance = json_set(COALESCE(provenance, '{}'), '$.expected_digest', json(?), '$.observed_digest', json(?), '$.integrity_status', ?) WHERE id = (SELECT agent_id FROM installation_operations WHERE id = ?) AND version = (SELECT version FROM installation_operations WHERE id = ?)").run(expected, observed, status, JSON.stringify(expected), JSON.stringify(observed), status, operationId, operationId);
}

export function getInstallationOperation(id: string, machineDir?: string): InstallationOperation | undefined {
  const db = tables(machineDir);
  const row = db.prepare("SELECT * FROM installation_operations WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? operation(row) : undefined;
}

export function getLatestAgentAuthenticationOperation(id: string, version: string, machineDir?: string): AgentAuthenticationOperation | undefined {
  const db = tables(machineDir);
  const row = db.prepare("SELECT * FROM agent_authentication_operations WHERE agent_id = ? AND version = ? ORDER BY started_at DESC LIMIT 1").get(id, version) as Record<string, unknown> | undefined;
  return row ? authenticationOperation(row) : undefined;
}

export function getAgentAuthenticationOperation(id: string, machineDir?: string): AgentAuthenticationOperation | undefined {
  const db = tables(machineDir);
  const row = db.prepare("SELECT * FROM agent_authentication_operations WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? authenticationOperation(row) : undefined;
}

export function beginAgentAuthentication(input: Pick<AgentAuthenticationOperation, "id" | "agent_id" | "version" | "method_id" | "method_name">, machineDir?: string): AgentAuthenticationOperation {
  const db = tables(machineDir);
  const startedAt = new Date().toISOString();
  db.prepare("INSERT INTO agent_authentication_operations (id, agent_id, version, method_id, method_name, status, started_at) VALUES (?, ?, ?, ?, ?, 'authenticating', ?)").run(input.id, input.agent_id, input.version, input.method_id, input.method_name, startedAt);
  return getAgentAuthenticationOperation(input.id, machineDir)!;
}

export function finishAgentAuthentication(id: string, status: Exclude<AgentAuthenticationOperation["status"], "authenticating">, error: string | null, machineDir?: string): AgentAuthenticationOperation {
  const db = tables(machineDir);
  db.prepare("UPDATE agent_authentication_operations SET status = ?, finished_at = ?, error = ? WHERE id = ? AND status = 'authenticating'").run(status, new Date().toISOString(), error, id);
  return getAgentAuthenticationOperation(id, machineDir)!;
}

export function removeInstalledAgent(id: string, version: string, machineDir?: string): boolean {
  const db = tables(machineDir);
  return db.prepare("DELETE FROM installed_agents WHERE id = ? AND version = ? AND status != 'installing'").run(id, version).changes > 0;
}

export function setAgentReadiness(id: string, version: string, result: { readiness_status: InstalledAgent["readiness_status"]; readiness_error: string | null; protocol_version: number | null; capabilities: unknown; auth_methods: unknown; raw_initialize: unknown; probed_at: string }, machineDir?: string): InstalledAgent {
  const db = tables(machineDir);
  db.prepare("UPDATE installed_agents SET readiness_status = ?, readiness_error = ?, protocol_version = ?, capabilities = ?, auth_methods = ?, raw_initialize = ?, probed_at = ?, updated_at = ? WHERE id = ? AND version = ?").run(result.readiness_status, result.readiness_error, result.protocol_version, result.capabilities ? JSON.stringify(result.capabilities) : null, JSON.stringify(result.auth_methods), result.raw_initialize ? JSON.stringify(result.raw_initialize) : null, result.probed_at, result.probed_at, id, version);
  return getInstalledAgent(id, version, machineDir)!;
}
