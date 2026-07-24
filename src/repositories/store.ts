import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { getGlobalDir } from "../daemon/config.js";
import { openMachineDb } from "../storage/machine.js";

export interface Repository {
  id: string;
  path: string;
  name: string;
  created_at: string;
  updated_at: string;
  preferences: Record<string, unknown>;
  legacy_state: "preserved" | "none";
}

export class RepositoryError extends Error {
  constructor(public readonly code: "missing_path" | "not_directory" | "not_git" | "duplicate_path", message: string) {
    super(message);
    this.name = "RepositoryError";
  }
}

function rowToRepository(row: Record<string, unknown>): Repository {
  let preferences: Record<string, unknown> = {};
  try { preferences = JSON.parse(String(row.preferences ?? "{}")) as Record<string, unknown>; } catch { /* use empty preferences */ }
  return {
    id: String(row.id), path: String(row.path), name: String(row.name),
    created_at: String(row.created_at), updated_at: String(row.updated_at), preferences,
    legacy_state: existsSync(resolve(String(row.path), ".marshal", "state.db")) ? "preserved" : "none",
  };
}

function canonicalGitRoot(input: string): string {
  const requested = resolve(input.trim());
  if (!existsSync(requested)) throw new RepositoryError("missing_path", `Repository path does not exist: ${input}`);
  if (!statSync(requested).isDirectory()) throw new RepositoryError("not_directory", `Repository path is not a directory: ${input}`);
  let gitRoot: string;
  try {
    gitRoot = execFileSync("git", ["-C", requested, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return realpathSync(gitRoot);
  } catch {
    return realpathSync(requested);
  }
}

export function listRepositories(machineDir = getGlobalDir()): Repository[] {
  const db = openMachineDb(machineDir);
  return (db.prepare("SELECT * FROM repositories ORDER BY name COLLATE NOCASE, path").all() as Record<string, unknown>[]).map(rowToRepository);
}

export function getRepository(id: string, machineDir = getGlobalDir()): Repository | undefined {
  const db = openMachineDb(machineDir);
  const row = db.prepare("SELECT * FROM repositories WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToRepository(row) : undefined;
}

export function registerRepository(inputPath: string, machineDir = getGlobalDir()): Repository {
  const path = canonicalGitRoot(inputPath);
  const db = openMachineDb(machineDir);
  const existing = db.prepare("SELECT * FROM repositories WHERE path = ?").get(path) as Record<string, unknown> | undefined;
  if (existing) throw new RepositoryError("duplicate_path", `Repository is already registered: ${path}`);
  const id = randomUUID();
  db.prepare("INSERT INTO repositories (id, path, name) VALUES (?, ?, ?)").run(id, path, basename(path) || dirname(path));
  return getRepository(id, machineDir)!;
}

export function removeRepository(id: string, machineDir = getGlobalDir()): boolean {
  const db = openMachineDb(machineDir);
  const result = db.prepare("DELETE FROM repositories WHERE id = ?").run(id);
  const selected = db.prepare("SELECT value FROM machine_preferences WHERE key = 'selected_repository_id'").get() as { value: string } | undefined;
  if (selected?.value === id) db.prepare("DELETE FROM machine_preferences WHERE key = 'selected_repository_id'").run();
  return result.changes > 0;
}

export function getSelectedRepository(machineDir = getGlobalDir()): Repository | undefined {
  const db = openMachineDb(machineDir);
  const row = db.prepare("SELECT value FROM machine_preferences WHERE key = 'selected_repository_id'").get() as { value: string } | undefined;
  return row ? getRepository(row.value, machineDir) : undefined;
}

export function selectRepository(id: string, machineDir = getGlobalDir()): Repository {
  const repository = getRepository(id, machineDir);
  if (!repository) throw new Error(`Repository not found: ${id}`);
  const db = openMachineDb(machineDir);
  db.prepare("INSERT INTO machine_preferences (key, value) VALUES ('selected_repository_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(id);
  return repository;
}

export function repositoryRoot(machineDir = getGlobalDir()): string | undefined { return getSelectedRepository(machineDir)?.path; }
