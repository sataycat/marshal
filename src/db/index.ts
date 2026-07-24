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
    "tasks",
    "runs",
    "run_operations",
    "run_events",
    "spec_messages",
    "spec_author_sessions",
    "spec_author_operations",
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
      const column = table === "tasks" || table === "spec_author_sessions" ? "repository_id_v2" : "repository_id";
      db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} IS NULL`).run(repositoryId);
    }
    db.prepare("UPDATE tasks SET repository_id_v2 = ? WHERE repository_id_v2 IS NULL").run(repositoryId);
    db.prepare("UPDATE spec_author_sessions SET repository_id_v2 = ? WHERE repository_id_v2 IS NULL").run(repositoryId);
    db.prepare("UPDATE spec_messages SET repository_id = ? WHERE repository_id IS NULL AND task_id IN (SELECT id FROM tasks WHERE repository_id_v2 = ?)").run(repositoryId, repositoryId);
    db.prepare("UPDATE runs SET repository_id = ? WHERE repository_id IS NULL AND task_id IN (SELECT id FROM tasks WHERE repository_id_v2 = ?)").run(repositoryId, repositoryId);
    db.prepare("UPDATE run_operations SET repository_id = ? WHERE repository_id IS NULL AND run_id IN (SELECT id FROM runs WHERE repository_id = ?)").run(repositoryId, repositoryId);
    db.prepare("UPDATE run_events SET repository_id = ? WHERE repository_id IS NULL AND run_id IN (SELECT id FROM runs WHERE repository_id = ?)").run(repositoryId, repositoryId);
    db.prepare("UPDATE spec_author_operations SET repository_id = ? WHERE repository_id IS NULL AND author_session_id IN (SELECT id FROM spec_author_sessions WHERE repository_id_v2 = ?)").run(repositoryId, repositoryId);
  })();
  return db;
}
