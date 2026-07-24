import Database from "better-sqlite3";
import { resolve } from "node:path";
import { ensureDir, getGlobalDir } from "../daemon/config.js";
import { migrateDatabase } from "./migration.js";

export function machineDbPath(machineDir = getGlobalDir()): string {
  return resolve(machineDir, "machine.db");
}

export function openMachineDb(machineDir = getGlobalDir()): Database.Database {
  ensureDir(machineDir);
  const db = new Database(machineDbPath(machineDir));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrateDatabase(db, "machine");
  return db;
}
