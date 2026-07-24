import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { cwd } from "node:process";

export function getGlobalDir(): string {
  return process.env.MARSHAL_HOME
    ? resolve(process.env.MARSHAL_HOME)
    : resolve(homedir(), ".marshal");
}

export function getRepoStateDir(root = cwd()): string {
  return resolve(root, ".marshal");
}

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

export function initGlobalConfig(): string {
  return ensureDir(getGlobalDir());
}

export function initRepoState(root = cwd()): string {
  return ensureDir(getRepoStateDir(root));
}
