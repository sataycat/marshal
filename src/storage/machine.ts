import Database from "better-sqlite3";
import { getGlobalDir } from "../daemon/config.js";
import { ensureStorageLayout, storageLayout } from "./layout.js";
import { migrateDatabase } from "./migration.js";

export function machineDbPath(machineDir = getGlobalDir()): string {
  // The machine/repository database consolidation is Slice 4.  Until then,
  // the legacy machine schema stays on machine.db, but its path is still
  // resolved by the single storage contract.
  return storageLayout(machineDir).legacyMachineDatabasePath;
}

export function openMachineDb(machineDir = getGlobalDir()): Database.Database {
  ensureStorageLayout(machineDir);
  const db = new Database(machineDbPath(machineDir));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrateDatabase(db, "machine");
  return db;
}
