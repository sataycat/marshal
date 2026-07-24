import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const JOURNAL = "__drizzle_migrations";

export class DatabaseMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseMigrationError";
  }
}

function migrationDirectory(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "migrations");
}

function migrations(): Array<{ id: number; hash: string; sql: string }> {
  const directory = migrationDirectory();
  try {
    return readdirSync(directory)
      .filter((name) => /^\d+-.+\.sql$/.test(name))
      .sort()
      .map((name) => {
        const match = /^(\d+)-(.+)\.sql$/.exec(name)!;
        return { id: Number(match[1]), hash: match[2], sql: readFileSync(resolve(directory, name), "utf8") };
      });
  } catch (error) {
    throw new DatabaseMigrationError(`No packaged Marshal migrations found: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function tableNames(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((row) => row.name);
}

export function migrateDatabase(db: Database.Database, _legacyScope?: "machine" | "repository"): void {
  const available = migrations();
  if (available.length === 0) throw new DatabaseMigrationError("No packaged Marshal migrations found");
  const tables = tableNames(db);
  if (!tables.includes(JOURNAL) && tables.length > 0) throw new DatabaseMigrationError("legacy_layout_reset_required: Marshal database is not a fresh consolidated database; reset $MARSHAL_HOME");
  db.exec(`CREATE TABLE IF NOT EXISTS ${JOURNAL} (id INTEGER PRIMARY KEY NOT NULL, hash TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  const applied = db.prepare(`SELECT id, hash FROM ${JOURNAL} ORDER BY id`).all() as Array<{ id: number; hash: string }>;
  const known = new Map(available.map((migration) => [migration.id, migration]));
  for (const migration of applied) {
    const expected = known.get(migration.id);
    if (!expected || expected.hash !== migration.hash) throw new DatabaseMigrationError("Database created by a newer Marshal version");
  }
  const appliedIds = new Set(applied.map((migration) => migration.id));
  for (const migration of available) {
    if (appliedIds.has(migration.id)) continue;
    try {
      db.transaction(() => {
        db.exec(migration.sql);
        db.prepare(`INSERT INTO ${JOURNAL} (id, hash, created_at) VALUES (?, ?, ?)`).run(migration.id, migration.hash, Date.now());
      })();
    } catch (error) {
      throw new DatabaseMigrationError(`Failed to migrate consolidated database with migration ${migration.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
