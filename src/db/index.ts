import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getRepoStateDir, initRepoState } from "../daemon/config.js";
import { repositoryRoot } from "../repositories/store.js";
import { migrateDatabase } from "../storage/migration.js";

export function getDbPath(root?: string): string {
  const selected = root ?? repositoryRoot();
  if (!selected) throw new Error("No repository selected");
  return resolve(getRepoStateDir(selected), "state.db");
}

export function openDb(root?: string): Database.Database {
  const selected = root ?? repositoryRoot();
  if (!selected) throw new Error("No repository selected");
  initRepoState(selected);
  const dbPath = getDbPath(root);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrateDatabase(db, "repository");
  return db;
}
