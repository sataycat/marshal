import { chmodSync, mkdirSync } from "node:fs";
import { cwd } from "node:process";
import { resolve } from "node:path";
import {
  ensureStorageLayout,
  resolveMarshalHome,
  STORAGE_DIRECTORY_MODE,
  storageLayout,
  type StorageLayout,
} from "../storage/layout.js";

export function getGlobalDir(): string {
  return resolveMarshalHome();
}

export function getRepoStateDir(root = cwd()): string {
  return resolve(root, ".marshal");
}

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: STORAGE_DIRECTORY_MODE });
  chmodSync(path, STORAGE_DIRECTORY_MODE);
  return path;
}

export function initGlobalConfig(): string {
  return ensureStorageLayout().root;
}

export function initRepoState(root = cwd()): string {
  // Repository-local state remains a compatibility path until ADR-0012's
  // repository/database slices land. New daemon-owned paths must use the
  // storage layout module instead.
  return ensureDir(getRepoStateDir(root));
}

/** Resolve the daemon-owned path contract for the current or explicit home. */
export function getStorageLayout(machineDir?: string): StorageLayout {
  return storageLayout(machineDir);
}
