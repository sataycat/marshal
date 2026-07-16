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
  // Keep repositories initialized by Slice 1-4 usable after adding the
  // per-thread scratch buffer without introducing a migration framework.
  const columns = db.prepare("PRAGMA table_info(chat_threads)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "scratch_markdown")) {
    db.exec("ALTER TABLE chat_threads ADD COLUMN scratch_markdown TEXT NOT NULL DEFAULT ''");
  }
  const messageColumns = db.prepare("PRAGMA table_info(chat_messages)").all() as { name: string }[];
  if (!messageColumns.some((column) => column.name === "attachment_ids")) {
    db.exec("ALTER TABLE chat_messages ADD COLUMN attachment_ids TEXT NOT NULL DEFAULT '[]'");
  }

  return db;
}
