import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const JOURNAL = "__drizzle_migrations";
const LEGACY_TABLES = {
  machine: new Set([
    "repositories",
    "machine_preferences",
    "registry_snapshots",
    "registry_refreshes",
    "installed_agents",
    "installation_operations",
    "agent_authentication_operations",
    "agent_removal_operations",
    "agent_removal_tombstones",
    "agent_credential_bindings",
    "workflow_profiles",
    "agent_assignments",
  ]),
  repository: new Set([
    "tasks",
    "runs",
    "run_operations",
    "run_events",
    "spec_messages",
    "chat_threads",
    "chat_messages",
    "chat_attachments",
    "acp_sessions",
    "acp_prompts",
    "acp_events",
    "permission_requests",
    "spec_author_sessions",
    "spec_author_operations",
  ]),
};

export class DatabaseMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseMigrationError";
  }
}

function migrationDirectory(scope: "machine" | "repository"): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "migrations", scope);
}

function migrations(
  scope: "machine" | "repository",
): Array<{ id: number; hash: string; sql: string }> {
  const directory = migrationDirectory(scope);
  return readdirSync(directory)
    .filter((name) => /^\d+-.+\.sql$/.test(name))
    .sort()
    .map((name) => {
      const match = /^(\d+)-(.+)\.sql$/.exec(name)!;
      return {
        id: Number(match[1]),
        hash: match[2],
        sql: readFileSync(resolve(directory, name), "utf8"),
      };
    });
}

function tableNames(db: Database.Database): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function columns(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
}

function adoptLegacy(db: Database.Database, scope: "machine" | "repository"): void {
  const additions =
    scope === "repository"
      ? [
          ["tasks", "repository_id TEXT", "workflow_profile_id TEXT"],
          [
            "chat_threads",
            "repository_id TEXT",
            "title TEXT NOT NULL DEFAULT 'New session'",
            "status TEXT NOT NULL DEFAULT 'active'",
            "agent_version TEXT NOT NULL DEFAULT 'legacy'",
            "agent_provenance TEXT NOT NULL DEFAULT '{}'",
            "session_config_options TEXT NOT NULL DEFAULT '[]'",
            "session_modes TEXT",
            "session_initialized INTEGER NOT NULL DEFAULT 0",
            "scratch_markdown TEXT NOT NULL DEFAULT ''",
            "failure TEXT",
          ],
          [
            "chat_messages",
            "attachment_ids TEXT NOT NULL DEFAULT '[]'",
            "prompt_status TEXT",
            "failure TEXT",
          ],
          ["spec_messages", "prompt_status TEXT", "failure TEXT"],
          [
            "acp_sessions",
            "owner_type TEXT",
            "owner_id TEXT",
            "agent_provenance TEXT NOT NULL DEFAULT '{}'",
            "failure TEXT",
          ],
          [
            "acp_prompts",
            "content TEXT NOT NULL DEFAULT '{}'",
            "failure TEXT",
            "message_id INTEGER",
            "resubmission_of TEXT",
            "session_id TEXT",
          ],
          ["acp_events", "session_id TEXT"],
          ["permission_requests", "thread_id TEXT"],
          [
            "spec_author_sessions",
            "agent_provenance TEXT NOT NULL DEFAULT '{}'",
            "failure TEXT",
            "message_id INTEGER",
          ],
          ["spec_author_operations", "failure TEXT"],
          [
            "runs",
            "agent_version TEXT NOT NULL DEFAULT 'legacy'",
            "capabilities TEXT NOT NULL DEFAULT '{}'",
            "assignment_config TEXT NOT NULL DEFAULT '{}'",
            "supervisor_session_id TEXT",
            "operation_id TEXT",
            "verification_status TEXT",
            "verification_output TEXT",
            "agent_provenance TEXT NOT NULL DEFAULT '{}'",
            "failure TEXT",
            "auth_recovery_resolved_at DATETIME",
            "superseded_by_run_id INTEGER",
          ],
        ]
      : [
          [
            "installed_agents",
            "installation_id TEXT NOT NULL DEFAULT ''",
            "provenance TEXT",
            "installation_root TEXT",
            "readiness_status TEXT NOT NULL DEFAULT 'unknown'",
            "readiness_error TEXT",
            "readiness_failure TEXT",
            "protocol_version INTEGER",
            "capabilities TEXT",
            "auth_methods TEXT NOT NULL DEFAULT '[]'",
            "raw_initialize TEXT",
            "probed_at TEXT",
            "expected_digest TEXT",
            "observed_digest TEXT",
            "is_default INTEGER NOT NULL DEFAULT 0",
          ],
          [
            "installation_operations",
            "distribution TEXT NOT NULL DEFAULT 'npx'",
            "installation_id TEXT NOT NULL DEFAULT ''",
            "phase TEXT NOT NULL DEFAULT 'resolving'",
            "temporary_root TEXT",
            "published_root TEXT",
            "recovery_metadata TEXT",
            "error_code TEXT",
            "diagnostic TEXT",
            "activation_status TEXT NOT NULL DEFAULT 'not_started'",
            "activation_started_at TEXT",
            "activation_finished_at TEXT",
            "activation_error TEXT",
            "activation_error_code TEXT",
            "activation_diagnostic TEXT",
          ],
          [
            "agent_authentication_operations",
            "installation_id TEXT NOT NULL DEFAULT ''",
            "failure TEXT",
            "method_type TEXT NOT NULL DEFAULT 'agent'",
            "terminal_exit_code INTEGER",
            "terminal_signal INTEGER",
            "terminal_output_truncated INTEGER NOT NULL DEFAULT 0",
            "terminal_last_activity_at TEXT",
            "terminal_diagnostic TEXT",
          ],
          ["agent_assignments", "agent_provenance TEXT NOT NULL DEFAULT '{}'"],
        ];
  for (const [table, ...definitions] of additions) {
    const known = columns(db, table);
    for (const definition of definitions) {
      const name = definition.split(" ", 1)[0];
      if (!known.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    }
  }
  if (scope === "repository")
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_tasks_workflow_owner ON tasks(repository_id, workflow_profile_id)",
    );
  if (scope === "machine")
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_installed_agents_identity ON installed_agents(id, version, distribution, installation_id)",
    );
}

export function migrateDatabase(db: Database.Database, scope: "machine" | "repository"): void {
  const available = migrations(scope);
  if (!available.length)
    throw new DatabaseMigrationError(`No migrations packaged for ${scope} database`);
  const existing = tableNames(db);
  if (!existing.includes(JOURNAL)) {
    if (existing.some((name) => !LEGACY_TABLES[scope].has(name)))
      throw new DatabaseMigrationError(`${scope} database has an unsupported pre-migration schema`);
    if (existing.length > 0) adoptLegacy(db, scope);
    db.exec(
      `CREATE TABLE ${JOURNAL} (id INTEGER PRIMARY KEY NOT NULL, hash TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    );
    if (existing.length > 0)
      db.prepare(`INSERT INTO ${JOURNAL} (id, hash, created_at) VALUES (?, ?, ?)`).run(
        available[0].id,
        available[0].hash,
        Date.now(),
      );
  }
  const applied = db.prepare(`SELECT id, hash FROM ${JOURNAL} ORDER BY id`).all() as Array<{
    id: number;
    hash: string;
  }>;
  const known = new Map(available.map((migration) => [migration.id, migration]));
  for (const migration of applied) {
    const expected = known.get(migration.id);
    if (!expected || expected.hash !== migration.hash)
      throw new DatabaseMigrationError("Database created by a newer Marshal version");
  }
  const appliedIds = new Set(applied.map((migration) => migration.id));
  for (const migration of available) {
    if (appliedIds.has(migration.id)) continue;
    try {
      db.transaction(() => {
        db.exec(migration.sql);
        db.prepare(`INSERT INTO ${JOURNAL} (id, hash, created_at) VALUES (?, ?, ?)`).run(
          migration.id,
          migration.hash,
          Date.now(),
        );
      })();
    } catch (error) {
      throw new DatabaseMigrationError(
        `Failed to migrate ${scope} database with migration ${migration.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
