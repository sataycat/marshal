import Database from "better-sqlite3";
import { getGlobalDir } from "../daemon/config.js";
import { ensureStorageLayout, storageLayout } from "./layout.js";
import { migrateDatabase } from "./migration.js";

export function machineDbPath(machineDir = getGlobalDir()): string {
  return storageLayout(machineDir).databasePath;
}

export function openMachineDb(machineDir = getGlobalDir()): Database.Database {
  ensureStorageLayout(machineDir);
  const db = new Database(machineDbPath(machineDir));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrateDatabase(db);
  return db;
}
