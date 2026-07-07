import ignore from "ignore";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { logger } from "../logger.js";

const BLOCKED_DIRS = new Set([
  "node_modules",
  ".pnpm-store",
  ".next",
  "dist",
  "build",
  "target",
  "coverage",
  ".cache",
  ".turbo",
  ".parcel-cache",
  ".webpack",
]);

export function loadWorktreeInclude(repoRoot: string): ignore.Ignore | null {
  const path = resolve(repoRoot, ".worktreeinclude");
  if (!existsSync(path)) {
    return null;
  }
  const raw = readFileSync(path, "utf8");
  return ignore().add(raw);
}

function isBlockedDir(segment: string): boolean {
  return BLOCKED_DIRS.has(segment);
}

function normalizePath(relPath: string): string {
  return relPath.replace(/\\/g, "/");
}

function hasBlockedDir(relativePath: string): boolean {
  return normalizePath(relativePath).split("/").some(isBlockedDir);
}

function isGitIgnored(repoRoot: string, relPath: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", relPath], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function walkDir(dir: string, callback: (path: string) => void): void {
  for (const entry of readdirSync(dir)) {
    if (entry === ".git") continue;
    const fullPath = resolve(dir, entry);
    const stat = lstatSync(fullPath);
    if (stat.isDirectory()) {
      walkDir(fullPath, callback);
    } else if (stat.isFile()) {
      callback(fullPath);
    }
  }
}

export function copyWorktreeIncludes(repoRoot: string, worktreePath: string): void {
  const matcher = loadWorktreeInclude(repoRoot);
  if (!matcher) {
    return;
  }

  const copied: string[] = [];
  const skipped: string[] = [];

  walkDir(repoRoot, (sourcePath) => {
    const relPath = relative(repoRoot, sourcePath);
    const normalizedRelPath = normalizePath(relPath);

    if (hasBlockedDir(normalizedRelPath)) {
      skipped.push(normalizedRelPath);
      return;
    }

    if (!matcher.ignores(normalizedRelPath)) {
      return;
    }

    if (!isGitIgnored(repoRoot, relPath)) {
      return;
    }

    const destPath = resolve(worktreePath, relPath);
    if (existsSync(destPath)) {
      return;
    }

    try {
      const stat = lstatSync(sourcePath);
      if (stat.isSymbolicLink()) {
        skipped.push(relPath);
        return;
      }
      mkdirSync(dirname(destPath), { recursive: true });
      copyFileSync(sourcePath, destPath);
      copied.push(relPath);
    } catch (err) {
      logger.warn({ err, relPath }, "Failed to copy .worktreeinclude file");
      skipped.push(relPath);
    }
  });

  if (copied.length > 0) {
    logger.info({ copied: copied.length }, "Copied .worktreeinclude files");
  }
  if (skipped.length > 0) {
    logger.warn({ skipped }, "Skipped blocked or symlink .worktreeinclude matches");
  }
}
