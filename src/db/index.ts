import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getRepoStateDir, initRepoState } from "../daemon/config.js";

export function getDbPath(root?: string): string {
  return resolve(getRepoStateDir(root), "state.db");
}

export function openDb(root?: string): Database.Database {
  initRepoState(root);
  const dbPath = getDbPath(root);
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  const schemaPath = resolve(dirname(fileURLToPath(import.meta.url)), "schema.sql");
  const schema = readFileSync(schemaPath, "utf8");
  db.exec(schema);

  return db;
}
