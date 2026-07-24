import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { getGlobalDir } from "../daemon/config.js";
import { ensureStorageLayout } from "../storage/layout.js";
import { DatabaseMigrationError, migrateDatabase } from "../storage/migration.js";

export function getDbPath(root?: string): string {
  return ensureStorageLayout(storageRoot(root)).databasePath;
}

/** Open the one daemon database. The optional argument is MARSHAL_HOME only. */
export function openDb(machineDir?: string): Database.Database {
  return openDatabase(storageRoot(machineDir));
}

function storageRoot(candidate?: string): string {
  // A checkout is execution input, never a daemon storage root. Explicit
  // arguments are daemon-owned MARSHAL_HOME test seams and intentionally win
  // over the process environment so independent lifecycle tests cannot share
  // state accidentally.
  if (!candidate || (process.env.MARSHAL_HOME && !isAbsolute(candidate))) return getGlobalDir();
  // Legacy call sites sometimes still pass a source checkout while the
  // repository-ID migration is being completed. Never create daemon state in
  // that checkout; resolve it to the controlled home instead.
  if (existsSync(join(candidate, ".git"))) return getGlobalDir();
  return candidate;
}

/** Repository-scoped callers retain their ownership argument, but physical
 * storage is always the controlled daemon database. */
export function openRepositoryDb(repositoryId: string, machineDir?: string): Database.Database {
  void repositoryId;
  return openDatabase(machineDir ?? getGlobalDir());
}

export function openDatabase(machineDir = getGlobalDir()): Database.Database {
  const layout = ensureStorageLayout(machineDir);
  if (existsSync(`${layout.root}/machine.db`)) {
    throw new DatabaseMigrationError(
      "legacy_layout_reset_required: Marshal found the pre-consolidation machine.db layout. Stop the daemon, remove the old Marshal home, and start again with a fresh $MARSHAL_HOME.",
    );
  }
  const db = new Database(layout.databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  try {
    migrateDatabase(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
