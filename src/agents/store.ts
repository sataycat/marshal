import { openMachineDb } from "../storage/machine.js";
import type { InstalledAgent, InstallationOperation } from "./types.js";

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
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      error TEXT
    );
  `);
  return db;
}

function agent(row: Record<string, unknown>): InstalledAgent {
  return {
    id: String(row.id), version: String(row.version), source: "registry", license: String(row.license),
    distribution: "npx", package_specifier: String(row.package_specifier), launch: JSON.parse(String(row.launch)),
    registry_snapshot_fetched_at: String(row.registry_snapshot_fetched_at), integrity_status: "not_applicable",
    status: String(row.status) as InstalledAgent["status"], created_at: String(row.created_at), updated_at: String(row.updated_at),
    failure: row.failure === null || row.failure === undefined ? null : String(row.failure),
  };
}

function operation(row: Record<string, unknown>): InstallationOperation {
  return { id: String(row.id), agent_id: String(row.agent_id), version: String(row.version), package_specifier: String(row.package_specifier), status: String(row.status) as InstallationOperation["status"], started_at: String(row.started_at), finished_at: row.finished_at ? String(row.finished_at) : null, error: row.error ? String(row.error) : null };
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

export function createInstallation(input: Omit<InstalledAgent, "created_at" | "updated_at" | "failure">, operationId: string, machineDir?: string): InstallationOperation {
  const db = tables(machineDir);
  const now = new Date().toISOString();
  const op: InstallationOperation = { id: operationId, agent_id: input.id, version: input.version, package_specifier: input.package_specifier, status: "installing", started_at: now, finished_at: null, error: null };
  db.transaction(() => {
    db.prepare("INSERT INTO installed_agents (id, version, source, license, distribution, package_specifier, launch, registry_snapshot_fetched_at, integrity_status, status, created_at, updated_at, failure) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(id, version) DO UPDATE SET package_specifier = excluded.package_specifier, launch = excluded.launch, registry_snapshot_fetched_at = excluded.registry_snapshot_fetched_at, license = excluded.license, status = 'installing', updated_at = excluded.updated_at, failure = NULL").run(input.id, input.version, input.source, input.license, input.distribution, input.package_specifier, JSON.stringify(input.launch), input.registry_snapshot_fetched_at, input.integrity_status, "installing", now, now);
    db.prepare("INSERT INTO installation_operations (id, agent_id, version, package_specifier, status, started_at) VALUES (?, ?, ?, ?, 'installing', ?)").run(op.id, op.agent_id, op.version, op.package_specifier, op.started_at);
  })();
  return op;
}

export function finishInstallation(operationId: string, status: "installed" | "failed", error: string | null, machineDir?: string): InstallationOperation {
  const db = tables(machineDir);
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare("UPDATE installation_operations SET status = ?, finished_at = ?, error = ? WHERE id = ?").run(status, now, error, operationId);
    db.prepare("UPDATE installed_agents SET status = ?, updated_at = ?, failure = ? WHERE id = (SELECT agent_id FROM installation_operations WHERE id = ?) AND version = (SELECT version FROM installation_operations WHERE id = ?)").run(status, now, error, operationId, operationId);
  })();
  return getInstallationOperation(operationId, machineDir)!;
}

export function getInstallationOperation(id: string, machineDir?: string): InstallationOperation | undefined {
  const db = tables(machineDir);
  const row = db.prepare("SELECT * FROM installation_operations WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? operation(row) : undefined;
}

export function removeInstalledAgent(id: string, version: string, machineDir?: string): boolean {
  const db = tables(machineDir);
  return db.prepare("DELETE FROM installed_agents WHERE id = ? AND version = ? AND status != 'installing'").run(id, version).changes > 0;
}
