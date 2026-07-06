import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { cwd } from "node:process";

export const GLOBAL_DIR = resolve(homedir(), ".marshal");

export function getRepoStateDir(root = cwd()): string {
  return resolve(root, ".marshal");
}

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

export function initGlobalConfig(): string {
  return ensureDir(GLOBAL_DIR);
}

export function initRepoState(root = cwd()): string {
  return ensureDir(getRepoStateDir(root));
}
