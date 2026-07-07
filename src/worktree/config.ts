import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { logger } from "../logger.js";

export interface MarshalJson {
  worktree?: {
    setup?: string;
  };
}

export interface GlobalConfig {
  worktree?: {
    root?: string;
  };
  acpx?: {
    bin?: string;
    version?: string;
  };
}

export function loadMarshalJson(repoRoot: string): MarshalJson {
  const path = resolve(repoRoot, "marshal.json");
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as MarshalJson;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    logger.warn({ err, path }, "Failed to parse marshal.json");
    return {};
  }
}

export function loadGlobalConfig(): GlobalConfig {
  const path = process.env.MARSHAL_GLOBAL_CONFIG ?? resolve(homedir(), ".marshal", "config.json");
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as GlobalConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    logger.warn({ err, path }, "Failed to parse ~/.marshal/config.json");
    return {};
  }
}
