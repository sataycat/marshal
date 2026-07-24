import { chmodSync, mkdirSync } from "node:fs";
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

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: STORAGE_DIRECTORY_MODE });
  chmodSync(path, STORAGE_DIRECTORY_MODE);
  return path;
}

export function initGlobalConfig(): string {
  return ensureStorageLayout().root;
}

/** Resolve the daemon-owned path contract for the current or explicit home. */
export function getStorageLayout(machineDir?: string): StorageLayout {
  return storageLayout(machineDir);
}
