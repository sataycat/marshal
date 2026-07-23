import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const repositories = sqliteTable("repositories", {
  id: text().primaryKey(),
  path: text().notNull(),
  name: text().notNull(),
  preferences: text().notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
export const machinePreferences = sqliteTable("machine_preferences", {
  key: text().primaryKey(),
  value: text().notNull(),
});
export const registrySnapshots = sqliteTable("registry_snapshots", {
  id: text().primaryKey(),
  source: text().notNull(),
  version: text().notNull(),
  snapshot: text().notNull(),
  fetchedAt: text("fetched_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
export const registryRefreshes = sqliteTable("registry_refreshes", {
  id: text().primaryKey(),
  status: text().notNull(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  error: text(),
  snapshotFetchedAt: text("snapshot_fetched_at"),
});
export const installedAgents = sqliteTable("installed_agents", {
  id: text().notNull(),
  version: text().notNull(),
  source: text().notNull(),
  license: text().notNull(),
  distribution: text().notNull(),
  packageSpecifier: text("package_specifier").notNull(),
  launch: text().notNull(),
  registrySnapshotFetchedAt: text("registry_snapshot_fetched_at").notNull(),
  integrityStatus: text("integrity_status").notNull(),
  expectedDigest: text("expected_digest"),
  observedDigest: text("observed_digest"),
  installationId: text("installation_id").notNull(),
  provenance: text(),
  installationRoot: text("installation_root"),
  status: text().notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  failure: text(),
  isDefault: integer("is_default").notNull(),
});
