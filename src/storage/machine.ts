import Database from "better-sqlite3";
import { resolve } from "node:path";
import { GLOBAL_DIR, ensureDir } from "../daemon/config.js";

export function machineDbPath(machineDir = GLOBAL_DIR): string {
  return resolve(machineDir, "machine.db");
}

export function openMachineDb(machineDir = GLOBAL_DIR): Database.Database {
  ensureDir(machineDir);
  const db = new Database(machineDbPath(machineDir));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS repositories (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      preferences TEXT NOT NULL DEFAULT '{}',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS machine_preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}
