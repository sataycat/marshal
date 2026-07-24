import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getRepoStateDir, initRepoState } from "../daemon/config.js";
import { resolveRepositoryContext } from "../repositories/context.js";
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

/**
 * Open the interim split repository database through its registered ID.
 * Slice 4 can replace this physical opener without changing repository-store
 * ownership APIs.
 */
export function openRepositoryDb(repositoryId: string, machineDir?: string): Database.Database {
  const context = resolveRepositoryContext(repositoryId, machineDir);
  initRepoState(context.checkoutPath);
  const dbPath = getDbPath(context.checkoutPath);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrateDatabase(db, "repository");

  // A split database has one unambiguous registered owner. Backfill only
  // legacy NULLs; all subsequent store writes carry the immutable ID.
  const tables = [
    "chat_threads",
    "chat_messages",
    "chat_attachments",
    "acp_sessions",
    "acp_prompts",
    "acp_events",
    "permission_requests",
  ];
  db.transaction(() => {
    for (const table of tables) {
      db.prepare(`UPDATE ${table} SET repository_id = ? WHERE repository_id IS NULL`).run(
        repositoryId,
      );
    }
  })();
  return db;
}
