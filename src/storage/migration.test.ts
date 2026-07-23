import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrateDatabase, DatabaseMigrationError } from "./migration.js";

describe("database migrations", () => {
  it("creates the repository schema and journal for an empty database", () => {
    const db = new Database(":memory:");
    migrateDatabase(db, "repository");
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get(),
    ).toBeTruthy();
    expect(db.prepare("SELECT id FROM __drizzle_migrations").get()).toEqual({ id: 0 });
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
  });

  it("rejects an unknown journal entry", () => {
    const db = new Database(":memory:");
    db.exec(
      "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at INTEGER NOT NULL)",
    );
    db.prepare("INSERT INTO __drizzle_migrations VALUES (99, 'future', 0)").run();
    expect(() => migrateDatabase(db, "machine")).toThrowError(DatabaseMigrationError);
    expect(() => migrateDatabase(db, "machine")).toThrow("newer Marshal version");
  });

  it("adopts a recognized legacy repository schema and preserves data", () => {
    const db = new Database(":memory:");
    db.exec(
      "CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'backlog', spec_markdown TEXT NOT NULL DEFAULT '', retry_count INTEGER NOT NULL DEFAULT 0, last_failure TEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)",
    );
    db.prepare("INSERT INTO tasks (slug, title) VALUES ('kept', 'Kept task')").run();
    for (const table of [
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
    ])
      db.exec(`CREATE TABLE ${table} (id TEXT)`);
    migrateDatabase(db, "repository");
    expect(db.prepare("SELECT title FROM tasks WHERE slug = 'kept'").get()).toEqual({
      title: "Kept task",
    });
    expect(db.prepare("SELECT repository_id FROM tasks").get()).toEqual({ repository_id: null });
  });
});
