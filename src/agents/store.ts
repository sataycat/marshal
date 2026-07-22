import { openMachineDb } from "../storage/machine.js";
import { GLOBAL_DIR } from "../daemon/config.js";
import { validateAgentLaunchSpec, type AgentActivationStatus, type AgentAuthenticationOperation, type InstalledAgent, type InstallationOperation, type InstallationPhase } from "./types.js";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve, relative } from "node:path";
import { listRepositories } from "../repositories/store.js";
import { openDb } from "../db/index.js";
import type { AgentRemovalOperation, AgentRemovalReference } from "./types.js";
import { deleteAgentCredentials } from "./credentials.js";

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
       installation_id TEXT NOT NULL DEFAULT '',
      provenance TEXT,
      installation_root TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      failure TEXT,
       is_default INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY (id, version, distribution, installation_id)
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
       error TEXT,
       failure TEXT
       ,error_code TEXT
        ,diagnostic TEXT
       ,activation_status TEXT NOT NULL DEFAULT 'not_started'
       ,activation_started_at TEXT
       ,activation_finished_at TEXT
       ,activation_error TEXT
       ,activation_error_code TEXT
       ,activation_diagnostic TEXT
    );
     CREATE TABLE IF NOT EXISTS agent_authentication_operations (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      version TEXT NOT NULL,
      installation_id TEXT NOT NULL DEFAULT '',
      method_id TEXT NOT NULL,
       method_name TEXT NOT NULL,
       method_type TEXT NOT NULL DEFAULT 'agent',
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
       finished_at TEXT,
       error TEXT,
       failure TEXT,
       terminal_exit_code INTEGER,
       terminal_signal INTEGER,
       terminal_output_truncated INTEGER NOT NULL DEFAULT 0,
       terminal_last_activity_at TEXT,
       terminal_diagnostic TEXT
     );
     CREATE TABLE IF NOT EXISTS agent_removal_operations (
       id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, version TEXT NOT NULL, installation_id TEXT NOT NULL,
       status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, error TEXT, error_code TEXT,
       diagnostic TEXT, references_json TEXT NOT NULL DEFAULT '[]'
     );
     CREATE TABLE IF NOT EXISTS agent_removal_tombstones (
       installation_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, version TEXT NOT NULL, provenance TEXT NOT NULL,
       removed_at TEXT NOT NULL, removal_operation_id TEXT NOT NULL
     );
  `);
  for (const statement of [
     "ALTER TABLE installed_agents ADD COLUMN installation_id TEXT",
    "ALTER TABLE installed_agents ADD COLUMN provenance TEXT",
    "ALTER TABLE installed_agents ADD COLUMN installation_root TEXT",
    "ALTER TABLE installed_agents ADD COLUMN readiness_status TEXT NOT NULL DEFAULT 'unknown'",
    "ALTER TABLE installed_agents ADD COLUMN readiness_error TEXT",
    "ALTER TABLE installed_agents ADD COLUMN readiness_failure TEXT",
    "ALTER TABLE installed_agents ADD COLUMN protocol_version INTEGER",
    "ALTER TABLE installed_agents ADD COLUMN capabilities TEXT",
    "ALTER TABLE installed_agents ADD COLUMN auth_methods TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE installed_agents ADD COLUMN raw_initialize TEXT",
    "ALTER TABLE installed_agents ADD COLUMN probed_at TEXT",
    "ALTER TABLE installed_agents ADD COLUMN expected_digest TEXT",
    "ALTER TABLE installed_agents ADD COLUMN observed_digest TEXT",
    "ALTER TABLE installed_agents ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE installation_operations ADD COLUMN distribution TEXT NOT NULL DEFAULT 'npx'",
    "ALTER TABLE installation_operations ADD COLUMN installation_id TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE installation_operations ADD COLUMN phase TEXT NOT NULL DEFAULT 'resolving'",
    "ALTER TABLE installation_operations ADD COLUMN temporary_root TEXT",
    "ALTER TABLE installation_operations ADD COLUMN published_root TEXT",
    "ALTER TABLE installation_operations ADD COLUMN recovery_metadata TEXT",
     "ALTER TABLE installation_operations ADD COLUMN error_code TEXT",
     "ALTER TABLE installation_operations ADD COLUMN diagnostic TEXT",
     "ALTER TABLE installation_operations ADD COLUMN activation_status TEXT NOT NULL DEFAULT 'not_started'",
     "ALTER TABLE installation_operations ADD COLUMN activation_started_at TEXT",
     "ALTER TABLE installation_operations ADD COLUMN activation_finished_at TEXT",
     "ALTER TABLE installation_operations ADD COLUMN activation_error TEXT",
     "ALTER TABLE installation_operations ADD COLUMN activation_error_code TEXT",
     "ALTER TABLE installation_operations ADD COLUMN activation_diagnostic TEXT",
      "ALTER TABLE agent_authentication_operations ADD COLUMN installation_id TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE agent_authentication_operations ADD COLUMN failure TEXT",
      "ALTER TABLE agent_authentication_operations ADD COLUMN method_type TEXT NOT NULL DEFAULT 'agent'",
      "ALTER TABLE agent_authentication_operations ADD COLUMN terminal_exit_code INTEGER",
      "ALTER TABLE agent_authentication_operations ADD COLUMN terminal_signal INTEGER",
      "ALTER TABLE agent_authentication_operations ADD COLUMN terminal_output_truncated INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE agent_authentication_operations ADD COLUMN terminal_last_activity_at TEXT",
      "ALTER TABLE agent_authentication_operations ADD COLUMN terminal_diagnostic TEXT",
  ]) { try { db.exec(statement); } catch (error) { if (!(error instanceof Error) || !error.message.includes("duplicate column name")) throw error; } }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_installed_agents_identity ON installed_agents(id, version, distribution, installation_id)");
  return db;
}

export function interruptActiveAgentAuthentications(machineDir?: string): void {
  const db = tables(machineDir);
  db.prepare("UPDATE agent_authentication_operations SET status = 'interrupted', finished_at = ?, error = COALESCE(error, 'Authentication was interrupted by a daemon restart'), failure = COALESCE(failure, ?), terminal_diagnostic = CASE WHEN method_type = 'terminal' THEN COALESCE(terminal_diagnostic, ?) ELSE terminal_diagnostic END WHERE status = 'authenticating'").run(new Date().toISOString(), JSON.stringify({ kind: "cancelled", message: "Authentication was interrupted by a daemon restart", protocol_code: null, data: null }), JSON.stringify({ code: "terminal_daemon_restart", message: "The setup terminal process cannot be resumed after a daemon restart.", action: "Start terminal setup again." }));
}

function agent(row: Record<string, unknown>): InstalledAgent {
  const launch = validateAgentLaunchSpec(JSON.parse(String(row.launch)));
  const distribution = String(row.distribution) as InstalledAgent["distribution"];
  const installationRoot = String(row.installation_root ?? "");
  const provenance = row.provenance ? JSON.parse(String(row.provenance)) : {
    exact_version: String(row.version), distribution, source: "registry", package_specifier: row.package_specifier == null || row.package_specifier === "" ? null : String(row.package_specifier), archive_identity: null,
    registry_snapshot_fetched_at: row.registry_snapshot_fetched_at == null ? null : String(row.registry_snapshot_fetched_at), installation_root: installationRoot, integrity_status: String(row.integrity_status),
    expected_digest: row.expected_digest == null ? null : String(row.expected_digest), observed_digest: row.observed_digest == null ? null : String(row.observed_digest),
  };
  return {
    id: String(row.id), version: String(row.version), source: provenance.source, license: String(row.license),
    distribution, package_specifier: row.package_specifier == null || row.package_specifier === "" ? null : String(row.package_specifier), launch, provenance,
    installation_id: String(row.installation_id ?? `${row.id}@${row.version}`), installation_root: installationRoot,
    registry_snapshot_fetched_at: row.registry_snapshot_fetched_at == null ? null : String(row.registry_snapshot_fetched_at), integrity_status: String(row.integrity_status) as InstalledAgent["integrity_status"],
    status: String(row.status) as InstalledAgent["status"], created_at: String(row.created_at), updated_at: String(row.updated_at),
    failure: row.failure === null || row.failure === undefined ? null : String(row.failure),
    readiness_status: String(row.readiness_status ?? "unknown") as InstalledAgent["readiness_status"], readiness_error: row.readiness_error ? String(row.readiness_error) : null, readiness_failure: row.readiness_failure ? JSON.parse(String(row.readiness_failure)) : null,
    protocol_version: row.protocol_version == null ? null : Number(row.protocol_version), capabilities: row.capabilities ? JSON.parse(String(row.capabilities)) : null,
     auth_methods: row.auth_methods ? JSON.parse(String(row.auth_methods)) : [], raw_initialize: row.raw_initialize ? JSON.parse(String(row.raw_initialize)) : null, probed_at: row.probed_at ? String(row.probed_at) : null, is_default: Number(row.is_default ?? 0) === 1,
  };
}

function operation(row: Record<string, unknown>): InstallationOperation {
  return { id: String(row.id), agent_id: String(row.agent_id), version: String(row.version), package_specifier: row.package_specifier == null || row.package_specifier === "" ? null : String(row.package_specifier), distribution: String(row.distribution ?? "npx") as InstallationOperation["distribution"], installation_id: String(row.installation_id ?? ""), phase: String(row.phase ?? row.status) as InstallationPhase, temporary_root: row.temporary_root ? String(row.temporary_root) : null, published_root: row.published_root ? String(row.published_root) : null, recovery_metadata: row.recovery_metadata ? JSON.parse(String(row.recovery_metadata)) : null, status: String(row.status) as InstallationOperation["status"], activation_status: String(row.activation_status ?? "not_started") as InstallationOperation["activation_status"], activation_started_at: row.activation_started_at ? String(row.activation_started_at) : null, activation_finished_at: row.activation_finished_at ? String(row.activation_finished_at) : null, activation_error: row.activation_error ? String(row.activation_error) : null, activation_error_code: row.activation_error_code ? String(row.activation_error_code) : null, activation_diagnostic: row.activation_diagnostic ? JSON.parse(String(row.activation_diagnostic)) : null, started_at: String(row.started_at), finished_at: row.finished_at ? String(row.finished_at) : null, error: row.error ? String(row.error) : null, error_code: row.error_code ? String(row.error_code) : null, diagnostic: row.diagnostic ? JSON.parse(String(row.diagnostic)) : null };
}

function authenticationOperation(row: Record<string, unknown>): AgentAuthenticationOperation {
  return { id: String(row.id), agent_id: String(row.agent_id), version: String(row.version), installation_id: String(row.installation_id ?? ""), method_id: String(row.method_id), method_name: String(row.method_name), method_type: String(row.method_type ?? "agent"), status: String(row.status) as AgentAuthenticationOperation["status"], started_at: String(row.started_at), finished_at: row.finished_at ? String(row.finished_at) : null, error: row.error ? String(row.error) : null, failure: row.failure ? JSON.parse(String(row.failure)) : null, terminal_exit_code: row.terminal_exit_code == null ? null : Number(row.terminal_exit_code), terminal_signal: row.terminal_signal == null ? null : Number(row.terminal_signal), terminal_output_truncated: Number(row.terminal_output_truncated ?? 0) === 1, terminal_last_activity_at: row.terminal_last_activity_at ? String(row.terminal_last_activity_at) : null, terminal_diagnostic: row.terminal_diagnostic ? JSON.parse(String(row.terminal_diagnostic)) : null };
}
function removalOperation(row: Record<string, unknown>): AgentRemovalOperation { return { id: String(row.id), agent_id: String(row.agent_id), version: String(row.version), installation_id: String(row.installation_id), status: String(row.status) as AgentRemovalOperation["status"], started_at: String(row.started_at), finished_at: row.finished_at ? String(row.finished_at) : null, error: row.error ? String(row.error) : null, error_code: row.error_code ? String(row.error_code) : null, diagnostic: row.diagnostic ? JSON.parse(String(row.diagnostic)) : null, references: JSON.parse(String(row.references_json ?? "[]")) as AgentRemovalReference[] }; }

export function listInstalledAgents(machineDir?: string): InstalledAgent[] {
  const db = tables(machineDir);
  return (db.prepare("SELECT * FROM installed_agents ORDER BY id, version, distribution, installation_id").all() as Record<string, unknown>[]).map(agent);
}

export function getInstalledAgent(id: string, version: string, machineDir?: string, installationId?: string): InstalledAgent | undefined {
  const db = tables(machineDir);
  const row = db.prepare(installationId ? "SELECT * FROM installed_agents WHERE id = ? AND version = ? AND installation_id = ?" : "SELECT * FROM installed_agents WHERE id = ? AND version = ? ORDER BY is_default DESC, updated_at DESC LIMIT 1").get(...(installationId ? [id, version, installationId] : [id, version])) as Record<string, unknown> | undefined;
  return row ? agent(row) : undefined;
}

export function getLatestInstallationOperation(id: string, version: string, machineDir?: string): InstallationOperation | undefined {
  const db = tables(machineDir);
  const row = db.prepare("SELECT * FROM installation_operations WHERE agent_id = ? AND version = ? ORDER BY started_at DESC LIMIT 1").get(id, version) as Record<string, unknown> | undefined;
  return row ? operation(row) : undefined;
}

export function createInstallation(input: Omit<InstalledAgent, "created_at" | "updated_at" | "failure" | "provenance" | "installation_id" | "installation_root" | "is_default" | "readiness_failure"> & Partial<Pick<InstalledAgent, "provenance" | "installation_id" | "installation_root" | "is_default" | "readiness_failure">>, operationId: string, machineDir?: string, metadata: Partial<Pick<InstallationOperation, "phase" | "temporary_root" | "published_root" | "recovery_metadata">> = {}): InstallationOperation {
  const db = tables(machineDir);
  const now = new Date().toISOString();
  const installationRoot = input.installation_root ?? "";
  const installationId = input.installation_id ?? `${input.id}@${input.version}`;
  const provenance = input.provenance ?? { exact_version: input.version, distribution: input.distribution, source: input.source, package_specifier: input.package_specifier, archive_identity: null, registry_snapshot_fetched_at: input.registry_snapshot_fetched_at, installation_root: installationRoot, integrity_status: input.integrity_status };
   const op: InstallationOperation = { id: operationId, agent_id: input.id, version: input.version, package_specifier: input.package_specifier, distribution: input.distribution, installation_id: installationId, phase: metadata.phase ?? "resolving", temporary_root: metadata.temporary_root ?? null, published_root: metadata.published_root ?? installationRoot, recovery_metadata: metadata.recovery_metadata ?? null, status: "installing", activation_status: "not_started", activation_started_at: null, activation_finished_at: null, activation_error: null, activation_error_code: null, activation_diagnostic: null, started_at: now, finished_at: null, error: null, error_code: null, diagnostic: null };
  db.transaction(() => {
        db.prepare("INSERT INTO installed_agents (id, version, source, license, distribution, package_specifier, launch, registry_snapshot_fetched_at, integrity_status, expected_digest, observed_digest, installation_id, provenance, installation_root, status, created_at, updated_at, failure, is_default) VALUES (@id, @version, @source, @license, @distribution, @package, @launch, @snapshot, @integrity, @expected, @observed, @installation, @provenance, @root, 'installing', @now, @now, NULL, 0) ON CONFLICT(id, version, distribution, installation_id) DO UPDATE SET package_specifier = excluded.package_specifier, launch = excluded.launch, registry_snapshot_fetched_at = excluded.registry_snapshot_fetched_at, integrity_status = excluded.integrity_status, expected_digest = excluded.expected_digest, observed_digest = excluded.observed_digest, provenance = excluded.provenance, installation_root = excluded.installation_root, license = excluded.license, status = 'installing', updated_at = excluded.updated_at, failure = NULL").run({ id: input.id, version: input.version, source: input.source, license: input.license, distribution: input.distribution, package: input.package_specifier ?? "", launch: JSON.stringify(input.launch), snapshot: input.registry_snapshot_fetched_at ?? "unknown", integrity: input.integrity_status, expected: (input.provenance as { expected_digest?: string | null } | undefined)?.expected_digest ?? null, observed: (input.provenance as { observed_digest?: string | null } | undefined)?.observed_digest ?? null, installation: installationId, provenance: JSON.stringify(provenance), root: installationRoot, now });
        db.prepare("INSERT INTO installation_operations (id, agent_id, version, package_specifier, distribution, installation_id, phase, temporary_root, published_root, recovery_metadata, status, started_at, error_code, diagnostic, activation_status, activation_started_at, activation_finished_at, activation_error, activation_error_code, activation_diagnostic) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'installing', ?, NULL, NULL, 'not_started', NULL, NULL, NULL, NULL, NULL)").run(op.id, op.agent_id, op.version, op.package_specifier ?? "", op.distribution, op.installation_id, op.phase, op.temporary_root, op.published_root, op.recovery_metadata ? JSON.stringify(op.recovery_metadata) : null, op.started_at);
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

export function finishInstallation(operationId: string, status: "installed" | "failed" | "interrupted", error: string | null, machineDir?: string, details: { code?: string; diagnostic?: InstallationOperation["diagnostic"] } = {}): InstallationOperation {
  const db = tables(machineDir);
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare("UPDATE installation_operations SET status = ?, phase = ?, finished_at = ?, error = ?, error_code = ?, diagnostic = ? WHERE id = ?").run(status, status === "installed" ? "completed" : status, now, error, details.code ?? null, details.diagnostic ? JSON.stringify(details.diagnostic) : null, operationId);
     db.prepare("UPDATE installed_agents SET status = ?, updated_at = ?, failure = ? WHERE id = (SELECT agent_id FROM installation_operations WHERE id = ?) AND version = (SELECT version FROM installation_operations WHERE id = ?) AND distribution = (SELECT distribution FROM installation_operations WHERE id = ?) AND installation_id = (SELECT installation_id FROM installation_operations WHERE id = ?)").run(status, now, error, operationId, operationId, operationId, operationId);
     if (status === "installed") db.prepare("UPDATE installed_agents SET is_default = 1 WHERE id = (SELECT agent_id FROM installation_operations WHERE id = ?) AND installation_id = (SELECT installation_id FROM installation_operations WHERE id = ?) AND NOT EXISTS (SELECT 1 FROM installed_agents WHERE id = (SELECT agent_id FROM installation_operations WHERE id = ?) AND is_default = 1)").run(operationId, operationId, operationId);
  })();
  return getInstallationOperation(operationId, machineDir)!;
}

export function cancelInstallation(operationId: string, machineDir?: string): InstallationOperation {
  const db = tables(machineDir); const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare("UPDATE installation_operations SET status = 'interrupted', phase = 'interrupted', finished_at = ?, error = ?, error_code = ?, diagnostic = ? WHERE id = ? AND status = 'installing'").run(now, "Installation cancelled by the user", "installation_cancelled", JSON.stringify({ message: "Installation cancelled before publication", action: "Retry the installation." }), operationId);
    db.prepare("UPDATE installed_agents SET status = 'interrupted', updated_at = ?, failure = ? WHERE id = (SELECT agent_id FROM installation_operations WHERE id = ?) AND version = (SELECT version FROM installation_operations WHERE id = ?) AND distribution = (SELECT distribution FROM installation_operations WHERE id = ?) AND installation_id = (SELECT installation_id FROM installation_operations WHERE id = ?) AND status = 'installing'").run(now, "Installation cancelled by the user", operationId, operationId, operationId, operationId);
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

export function setDefaultInstalledAgent(agentId: string, installationId: string, machineDir?: string): InstalledAgent {
  const database = tables(machineDir);
  const selected = database.prepare("SELECT * FROM installed_agents WHERE id = ? AND installation_id = ? AND status = 'installed'").get(agentId, installationId) as Record<string, unknown> | undefined;
  if (!selected) throw new Error("Installed agent selection is not available");
  database.transaction(() => {
    database.prepare("UPDATE installed_agents SET is_default = 0 WHERE id = ?").run(agentId);
    database.prepare("UPDATE installed_agents SET is_default = 1, updated_at = ? WHERE id = ? AND installation_id = ?").run(new Date().toISOString(), agentId, installationId);
  })();
  return getInstalledAgent(agentId, String(selected.version), machineDir, installationId)!;
}

export function getDefaultInstalledAgent(agentId: string, machineDir?: string): InstalledAgent | undefined {
  const database = tables(machineDir);
  const row = database.prepare("SELECT * FROM installed_agents WHERE id = ? AND is_default = 1 AND status = 'installed'").get(agentId) as Record<string, unknown> | undefined;
  return row ? agent(row) : undefined;
}
export function clearDefaultInstalledAgent(agentId: string, installationId: string, machineDir?: string): void { tables(machineDir).prepare("UPDATE installed_agents SET is_default = 0, updated_at = ? WHERE id = ? AND installation_id = ?").run(new Date().toISOString(), agentId, installationId); }

export function persistInstallationIntegrity(operationId: string, expected: string | null, observed: string, status: "verified" | "unverified" | "mismatch", machineDir?: string): void {
  const db = tables(machineDir);
  db.prepare("UPDATE installed_agents SET expected_digest = ?, observed_digest = ?, integrity_status = ?, provenance = json_set(COALESCE(provenance, '{}'), '$.expected_digest', json(?), '$.observed_digest', json(?), '$.integrity_status', ?) WHERE id = (SELECT agent_id FROM installation_operations WHERE id = ?) AND version = (SELECT version FROM installation_operations WHERE id = ?) AND distribution = (SELECT distribution FROM installation_operations WHERE id = ?) AND installation_id = (SELECT installation_id FROM installation_operations WHERE id = ?)").run(expected, observed, status, JSON.stringify(expected), JSON.stringify(observed), status, operationId, operationId, operationId, operationId);
}

export function getInstallationOperation(id: string, machineDir?: string): InstallationOperation | undefined {
  const db = tables(machineDir);
  const row = db.prepare("SELECT * FROM installation_operations WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? operation(row) : undefined;
}

export function setInstallationActivation(
  operationId: string,
  status: AgentActivationStatus,
  machineDir?: string,
  details: { error?: string | null; code?: string | null; diagnostic?: InstallationOperation["activation_diagnostic"] } = {},
): InstallationOperation {
  const db = tables(machineDir);
  const current = getInstallationOperation(operationId, machineDir);
  if (!current) throw new Error("Installation operation not found");
  const now = new Date().toISOString();
  const terminal = status === "ready" || status === "authentication_required" || status === "failed" || status === "interrupted";
  db.prepare("UPDATE installation_operations SET activation_status = ?, activation_started_at = ?, activation_finished_at = ?, activation_error = ?, activation_error_code = ?, activation_diagnostic = ? WHERE id = ?").run(
    status,
    status === "checking" ? now : current.activation_started_at,
    terminal ? now : null,
    details.error ?? null,
    details.code ?? null,
    details.diagnostic ? JSON.stringify(details.diagnostic) : null,
    operationId,
  );
  return getInstallationOperation(operationId, machineDir)!;
}

export function listInstallationOperations(machineDir?: string): InstallationOperation[] {
  const db = tables(machineDir);
  return (db.prepare("SELECT * FROM installation_operations ORDER BY started_at DESC").all() as Record<string, unknown>[]).map(operation);
}

export function getLatestAgentAuthenticationOperation(id: string, version: string, machineDir?: string, installationId?: string): AgentAuthenticationOperation | undefined {
  const db = tables(machineDir);
  const row = db.prepare(installationId ? "SELECT * FROM agent_authentication_operations WHERE agent_id = ? AND version = ? AND installation_id = ? ORDER BY started_at DESC LIMIT 1" : "SELECT * FROM agent_authentication_operations WHERE agent_id = ? AND version = ? ORDER BY started_at DESC LIMIT 1").get(...(installationId ? [id, version, installationId] : [id, version])) as Record<string, unknown> | undefined;
  return row ? authenticationOperation(row) : undefined;
}

export function getAgentAuthenticationOperation(id: string, machineDir?: string): AgentAuthenticationOperation | undefined {
  const db = tables(machineDir);
  const row = db.prepare("SELECT * FROM agent_authentication_operations WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? authenticationOperation(row) : undefined;
}

export function beginAgentAuthentication(input: Pick<AgentAuthenticationOperation, "id" | "agent_id" | "version" | "installation_id" | "method_id" | "method_name"> & Partial<Pick<AgentAuthenticationOperation, "method_type">>, machineDir?: string): AgentAuthenticationOperation {
  const db = tables(machineDir);
  const startedAt = new Date().toISOString();
  db.prepare("INSERT INTO agent_authentication_operations (id, agent_id, version, installation_id, method_id, method_name, method_type, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'authenticating', ?)").run(input.id, input.agent_id, input.version, input.installation_id, input.method_id, input.method_name, input.method_type ?? "agent", startedAt);
  return getAgentAuthenticationOperation(input.id, machineDir)!;
}

export function finishAgentAuthentication(id: string, status: Exclude<AgentAuthenticationOperation["status"], "authenticating">, error: string | null, machineDir?: string, failure: AgentAuthenticationOperation["failure"] = null): AgentAuthenticationOperation {
  const db = tables(machineDir);
  db.prepare("UPDATE agent_authentication_operations SET status = ?, finished_at = ?, error = ?, failure = ? WHERE id = ? AND status = 'authenticating'").run(status, new Date().toISOString(), error, failure ? JSON.stringify(failure) : null, id);
  return getAgentAuthenticationOperation(id, machineDir)!;
}

export function updateTerminalAuthentication(id: string, input: { exitCode?: number | null; signal?: number | null; outputTruncated?: boolean; lastActivityAt?: string; diagnostic?: AgentAuthenticationOperation["terminal_diagnostic"] }, machineDir?: string): AgentAuthenticationOperation {
  const db = tables(machineDir);
  db.prepare("UPDATE agent_authentication_operations SET terminal_exit_code = COALESCE(?, terminal_exit_code), terminal_signal = COALESCE(?, terminal_signal), terminal_output_truncated = COALESCE(?, terminal_output_truncated), terminal_last_activity_at = COALESCE(?, terminal_last_activity_at), terminal_diagnostic = COALESCE(?, terminal_diagnostic) WHERE id = ?").run(input.exitCode ?? null, input.signal ?? null, input.outputTruncated === undefined ? null : Number(input.outputTruncated), input.lastActivityAt ?? null, input.diagnostic ? JSON.stringify(input.diagnostic) : null, id);
  return getAgentAuthenticationOperation(id, machineDir)!;
}

function removalReferences(id: string, version: string, installationId: string, machineDir?: string): AgentRemovalReference[] {
  const db = tables(machineDir); const refs: AgentRemovalReference[] = [];
  for (const row of db.prepare("SELECT id, method_name FROM agent_authentication_operations WHERE agent_id = ? AND version = ? AND installation_id = ? AND status = 'authenticating'").all(id, version, installationId) as Record<string, unknown>[]) refs.push({ type: "authentication", id: String(row.id), detail: `Authentication ${String(row.method_name)} is still running` });
  for (const row of db.prepare("SELECT id FROM installation_operations WHERE agent_id = ? AND version = ? AND installation_id = ? AND status = 'installing'").all(id, version, installationId) as Record<string, unknown>[]) refs.push({ type: "installation", id: String(row.id), detail: "Installation is still running" });
  for (const row of db.prepare("SELECT id FROM installation_operations WHERE agent_id = ? AND version = ? AND installation_id = ? AND activation_status = 'checking'").all(id, version, installationId) as Record<string, unknown>[]) refs.push({ type: "activation", id: String(row.id), detail: "Agent readiness check is still running" });
  try { for (const row of db.prepare("SELECT id, role FROM agent_assignments WHERE agent_id = ? AND agent_version = ?").all(id, version) as Record<string, unknown>[]) refs.push({ type: "workflow_assignment", id: String(row.id), detail: `Workflow assignment ${String(row.role)} must be reassigned` }); } catch { /* no workflow tables exist until a workflow is opened */ }
  for (const repository of listRepositories(machineDir)) {
    try {
      const database = openDb(repository.path);
      for (const row of database.prepare("SELECT id, status FROM acp_sessions WHERE agent_id = ? AND agent_version = ? AND status IN ('starting','running','idle','cancelling','recoverable')").all(id, version) as Record<string, unknown>[]) {
        const status = String(row.status); refs.push({ type: status === "recoverable" ? "recoverable_session" : "active_session", id: String(row.id), detail: `ACP session is ${status}; close or resolve it before removal` });
      }
    } catch { /* an uninitialized repository has no session references */ }
  }
  return refs;
}

export function getAgentRemovalOperation(id: string, machineDir?: string): AgentRemovalOperation | undefined { const row = tables(machineDir).prepare("SELECT * FROM agent_removal_operations WHERE id = ?").get(id) as Record<string, unknown> | undefined; return row ? removalOperation(row) : undefined; }
export function listAgentRemovalOperations(machineDir?: string): AgentRemovalOperation[] { return (tables(machineDir).prepare("SELECT * FROM agent_removal_operations ORDER BY started_at DESC").all() as Record<string, unknown>[]).map(removalOperation); }

export function removeInstalledAgent(id: string, version: string, machineDir?: string, installationId?: string): AgentRemovalOperation {
  const db = tables(machineDir); const prior = installationId ? db.prepare("SELECT * FROM agent_removal_operations WHERE agent_id = ? AND version = ? AND installation_id = ? ORDER BY started_at DESC LIMIT 1").get(id, version, installationId) as Record<string, unknown> | undefined : undefined;
  if (prior && ["removing", "completed"].includes(String(prior.status))) return removalOperation(prior);
  const selected = (installationId ? db.prepare("SELECT * FROM installed_agents WHERE id = ? AND version = ? AND installation_id = ?").get(id, version, installationId) : db.prepare("SELECT * FROM installed_agents WHERE id = ? AND version = ? ORDER BY is_default DESC, updated_at DESC LIMIT 1").get(id, version)) as Record<string, unknown> | undefined;
  if (!selected) throw Object.assign(new Error("Installed agent not found"), { code: "agent_not_found" });
  const identity = String(selected.installation_id);
  const existing = db.prepare("SELECT * FROM agent_removal_operations WHERE agent_id = ? AND version = ? AND installation_id = ? ORDER BY started_at DESC LIMIT 1").get(id, version, identity) as Record<string, unknown> | undefined;
  if (existing && ["removing", "completed"].includes(String(existing.status))) return removalOperation(existing);
  if (prior && ["removing", "completed"].includes(String(prior.status))) return removalOperation(prior);
  const refs = removalReferences(id, version, identity, machineDir); const opId = randomUUID(); const now = new Date().toISOString();
  db.prepare("INSERT INTO agent_removal_operations (id, agent_id, version, installation_id, status, started_at, references_json) VALUES (?, ?, ?, ?, ?, ?, ?)").run(opId, id, version, identity, refs.length ? "blocked" : "removing", now, JSON.stringify(refs));
  const operation = getAgentRemovalOperation(opId, machineDir)!;
  if (refs.length) { db.prepare("UPDATE agent_removal_operations SET error_code = ?, diagnostic = ? WHERE id = ?").run("agent_removal_conflict", JSON.stringify({ message: "Installation has live references", action: "Resolve the listed references, then retry removal.", details: { references: refs } }), opId); return getAgentRemovalOperation(opId, machineDir)!; }
  return executeAgentRemoval(opId, machineDir);
}

export function executeAgentRemoval(operationId: string, machineDir?: string): AgentRemovalOperation {
  const db = tables(machineDir); const op = getAgentRemovalOperation(operationId, machineDir); if (!op) throw new Error("Agent removal operation not found"); if (op.status === "completed") return op;
  const row = db.prepare("SELECT * FROM installed_agents WHERE id = ? AND version = ? AND installation_id = ?").get(op.agent_id, op.version, op.installation_id) as Record<string, unknown> | undefined;
  if (!row) { db.prepare("UPDATE agent_removal_operations SET status = 'completed', finished_at = ? WHERE id = ?").run(new Date().toISOString(), operationId); return getAgentRemovalOperation(operationId, machineDir)!; }
  try {
    const root = String(row.installation_root ?? ""); const base = resolve(machineDir ?? GLOBAL_DIR, "agents");
    if (root && (resolve(root) === base || relative(base, root).startsWith(".."))) throw new Error("Installation payload is outside Marshal's owned agents directory");
    if (root) rmSync(root, { recursive: true, force: true });
    deleteAgentCredentials(op.installation_id, machineDir);
    db.transaction(() => {
      db.prepare("INSERT OR REPLACE INTO agent_removal_tombstones (installation_id, agent_id, version, provenance, removed_at, removal_operation_id) VALUES (?, ?, ?, ?, ?, ?)").run(op.installation_id, op.agent_id, op.version, String(row.provenance ?? "{}"), new Date().toISOString(), operationId);
      db.prepare("DELETE FROM installed_agents WHERE id = ? AND version = ? AND installation_id = ?").run(op.agent_id, op.version, op.installation_id);
      db.prepare("UPDATE installed_agents SET is_default = 1 WHERE id = ? AND status = 'installed' AND is_default = 0 AND NOT EXISTS (SELECT 1 FROM installed_agents WHERE id = ? AND is_default = 1) AND installation_id = (SELECT installation_id FROM installed_agents WHERE id = ? AND status = 'installed' ORDER BY updated_at DESC LIMIT 1)").run(op.agent_id, op.agent_id, op.agent_id);
      db.prepare("UPDATE agent_removal_operations SET status = 'completed', finished_at = ?, error = NULL WHERE id = ?").run(new Date().toISOString(), operationId);
    })();
  } catch (error) { db.prepare("UPDATE agent_removal_operations SET status = 'failed', finished_at = ?, error = ?, error_code = 'agent_cleanup_failed', diagnostic = ? WHERE id = ?").run(new Date().toISOString(), error instanceof Error ? error.message : String(error), JSON.stringify({ message: "Marshal could not clean up the installation payload", action: "Fix the payload permissions or path, then retry removal." }), operationId); }
  return getAgentRemovalOperation(operationId, machineDir)!;
}

export function setAgentReadiness(id: string, version: string, result: { readiness_status: InstalledAgent["readiness_status"]; readiness_error: string | null; readiness_failure?: InstalledAgent["readiness_failure"]; protocol_version: number | null; capabilities: unknown; auth_methods: unknown; raw_initialize: unknown; probed_at: string }, machineDir?: string, installationId?: string): InstalledAgent {
  const db = tables(machineDir);
  db.prepare(installationId ? "UPDATE installed_agents SET readiness_status = ?, readiness_error = ?, readiness_failure = ?, protocol_version = ?, capabilities = ?, auth_methods = ?, raw_initialize = ?, probed_at = ?, updated_at = ? WHERE id = ? AND version = ? AND installation_id = ?" : "UPDATE installed_agents SET readiness_status = ?, readiness_error = ?, readiness_failure = ?, protocol_version = ?, capabilities = ?, auth_methods = ?, raw_initialize = ?, probed_at = ?, updated_at = ? WHERE id = ? AND version = ?").run(...(installationId ? [result.readiness_status, result.readiness_error, result.readiness_failure ? JSON.stringify(result.readiness_failure) : null, result.protocol_version, result.capabilities ? JSON.stringify(result.capabilities) : null, JSON.stringify(result.auth_methods), result.raw_initialize ? JSON.stringify(result.raw_initialize) : null, result.probed_at, result.probed_at, id, version, installationId] : [result.readiness_status, result.readiness_error, result.readiness_failure ? JSON.stringify(result.readiness_failure) : null, result.protocol_version, result.capabilities ? JSON.stringify(result.capabilities) : null, JSON.stringify(result.auth_methods), result.raw_initialize ? JSON.stringify(result.raw_initialize) : null, result.probed_at, result.probed_at, id, version]));
  return getInstalledAgent(id, version, machineDir, installationId)!;
}
