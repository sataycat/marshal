import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { getGlobalDir } from "../daemon/config.js";
import { ensureStorageLayout } from "../storage/layout.js";
import { DatabaseMigrationError, migrateDatabase } from "../storage/migration.js";

export function getDbPath(root?: string): string {
  // The optional argument remains for old development helpers. Daemon code
  // passes MARSHAL_HOME explicitly; an environment override always wins.
  const storageRoot = process.env.MARSHAL_HOME ? getGlobalDir() : root ?? getGlobalDir();
  return ensureStorageLayout(storageRoot).databasePath;
}

/** Open the one daemon database. `root` is a MARSHAL_HOME, never a checkout. */
export function openDb(root?: string): Database.Database {
  // `openDb` is the legacy unscoped helper used by development fixtures. Its
  // argument is a checkout path, so it must not influence physical storage.
  return openDatabase(root && !process.env.MARSHAL_HOME ? root : getGlobalDir());
}

/** Repository-scoped callers retain their ownership argument, but physical
 * storage is always the controlled daemon database. */
export function openRepositoryDb(repositoryId: string, machineDir?: string): Database.Database {
  const candidate = machineDir ?? getGlobalDir();
  const candidatePath = ensureStorageLayout(candidate).databasePath;
  if (existsSync(candidatePath)) {
    const probe = new Database(candidatePath, { readonly: true });
    try {
      if (probe.prepare("SELECT 1 FROM repositories WHERE id = ?").get(repositoryId)) return openDatabase(candidate);
    } catch {
      // Fall through to the controlled global home for checkout-path seams.
    } finally {
      probe.close();
    }
  }
  return openDatabase(getGlobalDir());
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
