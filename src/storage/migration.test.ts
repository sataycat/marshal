import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { DatabaseMigrationError, migrateDatabase } from "./migration.js";
import { openDatabase } from "../db/index.js";

describe("consolidated database migrations", () => {
  it("initializes an empty marshal.db and discovers packaged migrations", () => {
    const home = mkdtempSync(join(tmpdir(), "marshal-empty-"));
    const db = openDatabase(home);
    expect(existsSync(join(home, "marshal.db"))).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS count FROM __drizzle_migrations").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'repositories'").get()).toBeTruthy();
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    rmSync(home, { recursive: true, force: true });
  });

  it("rejects an unknown newer migration", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at INTEGER NOT NULL)");
    db.prepare("INSERT INTO __drizzle_migrations VALUES (99, 'future', 0)").run();
    expect(() => migrateDatabase(db)).toThrow("newer Marshal version");
  });

  it("rolls back a failed migration transaction", () => {
    const db = new Database(":memory:");
    migrateDatabase(db);
    db.prepare("DELETE FROM __drizzle_migrations").run();
    const before = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'repositories'").get();
    expect(() => db.transaction(() => { db.exec("CREATE TABLE migration_probe (id INTEGER)"); throw new Error("boom"); })()).toThrow("boom");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration_probe'").get()).toBeUndefined();
    expect(before).toBeTruthy();
  });

  it("recognizes an old split-layout database and gives reset guidance", () => {
    const home = mkdtempSync(join(tmpdir(), "marshal-legacy-"));
    const db = new Database(join(home, "marshal.db"));
    db.exec("CREATE TABLE old_table (id INTEGER)");
    db.close();
    expect(() => openDatabase(home)).toThrow(/legacy_layout_reset_required/);
    rmSync(home, { recursive: true, force: true });
  });
});
