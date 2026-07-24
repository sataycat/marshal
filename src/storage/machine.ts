import { getGlobalDir } from "../daemon/config.js";
import { ensureStorageLayout, storageLayout } from "./layout.js";
import { openDatabase } from "../db/index.js";
import type Database from "better-sqlite3";

export function machineDbPath(machineDir = getGlobalDir()): string {
  return storageLayout(machineDir).databasePath;
}

export function openMachineDb(machineDir = getGlobalDir()): Database.Database {
  ensureStorageLayout(machineDir);
  return openDatabase(machineDir);
}
