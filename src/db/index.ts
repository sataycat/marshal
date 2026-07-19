import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getRepoStateDir, initRepoState } from "../daemon/config.js";
import { repositoryRoot } from "../repositories/store.js";

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
  const threadColumns = db.prepare("PRAGMA table_info(chat_threads)").all() as { name: string }[];
  if (!threadColumns.some((column) => column.name === "repository_id")) {
    db.exec("ALTER TABLE chat_threads ADD COLUMN repository_id TEXT");
  }
  if (!threadColumns.some((column) => column.name === "agent_version")) {
    db.exec("ALTER TABLE chat_threads ADD COLUMN agent_version TEXT NOT NULL DEFAULT 'legacy'");
  }
  if (!threadColumns.some((column) => column.name === "agent_provenance")) db.exec("ALTER TABLE chat_threads ADD COLUMN agent_provenance TEXT NOT NULL DEFAULT '{}'");
  const sessionColumns = db.prepare("PRAGMA table_info(acp_sessions)").all() as { name: string }[];
  if (!sessionColumns.some((column) => column.name === "agent_provenance")) db.exec("ALTER TABLE acp_sessions ADD COLUMN agent_provenance TEXT NOT NULL DEFAULT '{}'");
  const authorColumns = db.prepare("PRAGMA table_info(spec_author_sessions)").all() as { name: string }[];
  if (!authorColumns.some((column) => column.name === "agent_provenance")) db.exec("ALTER TABLE spec_author_sessions ADD COLUMN agent_provenance TEXT NOT NULL DEFAULT '{}'");
  const taskColumns = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
  if (!taskColumns.some((column) => column.name === "repository_id")) db.exec("ALTER TABLE tasks ADD COLUMN repository_id TEXT");
  if (!taskColumns.some((column) => column.name === "workflow_profile_id")) db.exec("ALTER TABLE tasks ADD COLUMN workflow_profile_id TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_workflow_owner ON tasks(repository_id, workflow_profile_id)");

  const runColumns = db.prepare("PRAGMA table_info(runs)").all() as { name: string }[];
  const runMigrations: Array<[string, string]> = [
    ["agent_version", "TEXT NOT NULL DEFAULT 'legacy'"],
    ["capabilities", "TEXT NOT NULL DEFAULT '{}'"],
    ["assignment_config", "TEXT NOT NULL DEFAULT '{}'"],
    ["supervisor_session_id", "TEXT"],
    ["operation_id", "TEXT"],
    ["verification_status", "TEXT"],
    ["verification_output", "TEXT"],
    ["agent_provenance", "TEXT NOT NULL DEFAULT '{}'"],
  ];
  for (const [name, definition] of runMigrations) {
    if (!runColumns.some((column) => column.name === name)) db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${definition}`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS run_operations (
    id TEXT PRIMARY KEY, run_id INTEGER NOT NULL, operation TEXT NOT NULL,
    status TEXT NOT NULL, diagnostic TEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ended_at DATETIME, FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
  )`);

  return db;
}
