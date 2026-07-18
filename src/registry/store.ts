import { randomUUID } from "node:crypto";
import { openMachineDb } from "../storage/machine.js";
import { PUBLIC_REGISTRY_URL, type RegistryCatalog, type RegistryRefresh, type RegistrySnapshot } from "./types.js";

const SNAPSHOT_KEY = "public-v1";

function decode<T>(value: unknown, fallback: T): T {
  try { return JSON.parse(String(value)) as T; } catch { return fallback; }
}

function ensureTables(machineDir?: string): ReturnType<typeof openMachineDb> {
  const db = openMachineDb(machineDir);
  db.exec(`
    CREATE TABLE IF NOT EXISTS registry_snapshots (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      version TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      fetched_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS registry_refreshes (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      started_at DATETIME NOT NULL,
      finished_at DATETIME,
      error TEXT,
      snapshot_fetched_at DATETIME
    );
  `);
  return db;
}

export function getRegistryCatalog(machineDir?: string): RegistryCatalog {
  const db = ensureTables(machineDir);
  const snapshotRow = db.prepare("SELECT * FROM registry_snapshots WHERE id = ?").get(SNAPSHOT_KEY) as Record<string, unknown> | undefined;
  const refreshRow = db.prepare("SELECT * FROM registry_refreshes ORDER BY started_at DESC LIMIT 1").get() as Record<string, unknown> | undefined;
  const snapshot = snapshotRow ? decode<RegistrySnapshot>(snapshotRow.snapshot, { version: String(snapshotRow.version), agents: [], source: String(snapshotRow.source), fetched_at: String(snapshotRow.fetched_at) }) : null;
  const refresh = refreshRow ? {
    id: String(refreshRow.id), status: String(refreshRow.status) as RegistryRefresh["status"], started_at: String(refreshRow.started_at), finished_at: refreshRow.finished_at ? String(refreshRow.finished_at) : null, error: refreshRow.error ? String(refreshRow.error) : null, snapshot_fetched_at: refreshRow.snapshot_fetched_at ? String(refreshRow.snapshot_fetched_at) : null,
  } : null;
  return { snapshot, refresh };
}

export function beginRegistryRefresh(machineDir?: string): RegistryRefresh {
  const db = ensureTables(machineDir);
  const refresh: RegistryRefresh = { id: randomUUID(), status: "running", started_at: new Date().toISOString(), finished_at: null, error: null, snapshot_fetched_at: null };
  db.prepare("INSERT INTO registry_refreshes (id, status, started_at) VALUES (?, ?, ?)").run(refresh.id, refresh.status, refresh.started_at);
  return refresh;
}

export function completeRegistryRefresh(refreshId: string, snapshot: RegistrySnapshot, machineDir?: string): RegistryRefresh {
  const db = ensureTables(machineDir);
  const finishedAt = new Date().toISOString();
  const transaction = db.transaction(() => {
    db.prepare("INSERT INTO registry_snapshots (id, source, version, snapshot, fetched_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET source = excluded.source, version = excluded.version, snapshot = excluded.snapshot, fetched_at = excluded.fetched_at, updated_at = CURRENT_TIMESTAMP").run(SNAPSHOT_KEY, snapshot.source, snapshot.version, JSON.stringify(snapshot), snapshot.fetched_at);
    db.prepare("UPDATE registry_refreshes SET status = 'succeeded', finished_at = ?, snapshot_fetched_at = ?, error = NULL WHERE id = ?").run(finishedAt, snapshot.fetched_at, refreshId);
  });
  transaction();
  return getRegistryCatalog(machineDir).refresh!;
}

export function failRegistryRefresh(refreshId: string, error: string, machineDir?: string): RegistryRefresh {
  const db = ensureTables(machineDir);
  db.prepare("UPDATE registry_refreshes SET status = 'failed', finished_at = ?, error = ? WHERE id = ?").run(new Date().toISOString(), error, refreshId);
  return getRegistryCatalog(machineDir).refresh!;
}

export { PUBLIC_REGISTRY_URL };
