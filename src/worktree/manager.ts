import { createHash } from "node:crypto";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { getRepoStateDir } from "../daemon/config.js";
import { logger } from "../logger.js";
import { loadGlobalConfig, loadMarshalJson } from "./config.js";
import { copyWorktreeIncludes } from "./include.js";
import { branchNameForSlug, descriptorForSlug } from "./name.js";
import {
  DiffError,
  type DiffResult,
  MergeError,
  type MergeResult,
  parseDiffStats,
} from "./diff-merge.js";

export interface WorktreeInfo {
  slug: string;
  branch: string;
  path: string;
  descriptor: string;
}

interface WorktreeRecord {
  slug: string;
  branch: string;
  path: string;
  descriptor: string;
  createdAt: string;
}

interface WorktreeIndex {
  worktrees: WorktreeRecord[];
}

export interface WorktreeManagerOptions {
  worktreeRoot?: string;
}

export class WorktreeManager {
  readonly sourcePath: string;
  readonly worktreeRoot: string;
  private indexPath: string;

  constructor(sourcePath: string, options: WorktreeManagerOptions = {}) {
    const resolvedSourcePath = resolve(sourcePath);

    let topLevel: string;
    try {
      topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: resolvedSourcePath,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch {
      throw new Error(`Source path is not a git repository: ${resolvedSourcePath}`);
    }

    const repoRoot = resolve(topLevel);
    const root =
      options.worktreeRoot ??
      loadGlobalConfig().worktree?.root ??
      resolve(homedir(), ".marshal", "worktrees");
    const repoHash = createHash("sha256").update(repoRoot).digest("hex").slice(0, 8);
    this.sourcePath = repoRoot;
    this.worktreeRoot = resolve(root, repoHash);
    this.indexPath = resolve(getRepoStateDir(repoRoot), "worktrees.json");
  }

  private readIndex(): WorktreeIndex {
    if (!existsSync(this.indexPath)) {
      return { worktrees: [] };
    }
    try {
      return JSON.parse(readFileSync(this.indexPath, "utf8")) as WorktreeIndex;
    } catch (err) {
      logger.warn({ err, path: this.indexPath }, "Failed to parse worktree index");
      return { worktrees: [] };
    }
  }

  private writeIndex(index: WorktreeIndex): void {
    mkdirSync(dirname(this.indexPath), { recursive: true });
    writeFileSync(this.indexPath, JSON.stringify(index, null, 2));
  }

  private execGit(args: string[]): string {
    return execFileSync("git", args, {
      cwd: this.sourcePath,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  private ensureCleanEnough(): void {
    try {
      const status = this.execGit(["status", "--porcelain=v1"]);
      if (status.trim().length > 0) {
        logger.warn("Source checkout has uncommitted changes; worktree will be created from HEAD");
      }
    } catch {
      throw new Error("Unable to run git status; is this a git repository?");
    }
  }

  private resolveDescriptor(slug: string): string {
    const index = this.readIndex();
    const existing = new Set(index.worktrees.map((w) => w.descriptor));
    let attempt = 0;
    let descriptor: string;
    do {
      descriptor = descriptorForSlug(slug, attempt);
      attempt++;
    } while (existing.has(descriptor) && attempt < 100);
    return descriptor;
  }

  private runSetupScript(worktreePath: string, branch: string, slug: string): void {
    const config = loadMarshalJson(this.sourcePath);
    const setup = config.worktree?.setup;
    if (!setup || setup.trim().length === 0) {
      return;
    }

    logger.info({ worktreePath }, "Running worktree setup script");
    try {
      execSync(setup, {
        cwd: worktreePath,
        env: {
          ...process.env,
          MARSHAL_SOURCE_CHECKOUT_PATH: this.sourcePath,
          MARSHAL_WORKTREE_PATH: worktreePath,
          MARSHAL_TASK_SLUG: slug,
          MARSHAL_BRANCH_NAME: branch,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      logger.error({ err }, "Worktree setup script failed");
      throw new Error(`Setup script failed for task ${slug}: ${(err as Error).message}`);
    }
  }

  create(slug: string): WorktreeInfo {
    if (!slug || slug.trim().length === 0) {
      throw new Error("Task slug is required");
    }

    this.ensureCleanEnough();

    const index = this.readIndex();
    const existing = index.worktrees.find((w) => w.slug === slug);
    if (existing) {
      logger.info({ slug, path: existing.path }, "Reusing existing worktree");
      return {
        slug: existing.slug,
        branch: existing.branch,
        path: existing.path,
        descriptor: existing.descriptor,
      };
    }

    const descriptor = this.resolveDescriptor(slug);
    const branch = branchNameForSlug(slug, descriptor);
    const worktreePath = resolve(this.worktreeRoot, `${slug}-${descriptor}`);

    if (existsSync(worktreePath)) {
      throw new Error(`Worktree path already exists: ${worktreePath}`);
    }

    mkdirSync(dirname(worktreePath), { recursive: true });

    try {
      this.execGit(["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
    } catch (err) {
      throw new Error(`Failed to create worktree: ${(err as Error).message}`);
    }

    try {
      copyWorktreeIncludes(this.sourcePath, worktreePath);
    } catch (err) {
      logger.warn({ err }, "Failed to copy .worktreeinclude files");
    }

    try {
      this.runSetupScript(worktreePath, branch, slug);
    } catch (err) {
      // Remove the worktree and branch if setup fails so we don't leave a half-baked tree.
      try {
        this.execGit(["worktree", "remove", "--force", worktreePath]);
        this.execGit(["branch", "-D", branch]);
      } catch {
        // best effort
      }
      throw err;
    }

    const record: WorktreeRecord = {
      slug,
      branch,
      path: worktreePath,
      descriptor,
      createdAt: new Date().toISOString(),
    };

    index.worktrees.push(record);
    this.writeIndex(index);

    logger.info({ slug, branch, path: worktreePath }, "Worktree created");

    return {
      slug,
      branch,
      path: worktreePath,
      descriptor,
    };
  }

  destroy(slug: string): void {
    const index = this.readIndex();
    const idx = index.worktrees.findIndex((w) => w.slug === slug);
    if (idx === -1) {
      throw new Error(`No worktree found for task: ${slug}`);
    }

    const record = index.worktrees[idx];

    if (existsSync(record.path)) {
      try {
        this.execGit(["worktree", "remove", "--force", record.path]);
      } catch (err) {
        logger.warn({ err, path: record.path }, "git worktree remove failed; deleting manually");
        rmSync(record.path, { recursive: true, force: true });
      }
    }

    try {
      this.execGit(["branch", "-D", record.branch]);
    } catch (err) {
      logger.warn({ err, branch: record.branch }, "Failed to delete branch");
    }

    index.worktrees.splice(idx, 1);
    this.writeIndex(index);

    logger.info({ slug, branch: record.branch }, "Worktree destroyed");
  }

  list(): WorktreeInfo[] {
    return this.readIndex().worktrees.map((w) => ({
      slug: w.slug,
      branch: w.branch,
      path: w.path,
      descriptor: w.descriptor,
    }));
  }

  resolveTaskBranch(slug: string): string | undefined {
    return this.readIndex().worktrees.find((w) => w.slug === slug)?.branch;
  }

  diffForSlug(slug: string): DiffResult {
    const branch = this.resolveTaskBranch(slug);
    if (branch === undefined) {
      throw new DiffError(slug, "no worktree for task");
    }
    const diff = this.execGit(["diff", `HEAD...${branch}`]);
    return { diff, stats: parseDiffStats(diff) };
  }

  mergeTaskBranch(slug: string): MergeResult {
    const branch = this.resolveTaskBranch(slug);
    if (branch === undefined) {
      throw new MergeError(slug, "no worktree for task");
    }
    const headBranch = this.execGit(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    if (headBranch === "HEAD") {
      throw new MergeError(slug, "source checkout is in detached HEAD state");
    }
    const status = this.execGit(["status", "--porcelain=v1"]).trim();
    // Untracked files (e.g. the .marshal/ index dir) are safe to merge around.
    // Only block when there are tracked modifications or staged changes.
    const dirty = status
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("?? "));
    if (dirty.length > 0) {
      throw new MergeError(slug, "source checkout has uncommitted changes; refusing to merge");
    }
    try {
      this.execGit(["merge", "--no-ff", branch, "-m", `merge: ${slug}`]);
    } catch (err) {
      // Abort the in-progress merge so the source checkout is not left in a
      // conflicted state. If abort fails (no merge in progress) we ignore it.
      try {
        this.execGit(["merge", "--abort"]);
      } catch {
        // ignore
      }
      const stderr = (err as { stderr?: string }).stderr ?? (err as Error).message;
      if (/CONFLICT|conflict/i.test(stderr)) {
        throw new MergeError(slug, "merge conflict; resolve manually and retry");
      }
      throw new MergeError(slug, `git merge failed: ${(err as Error).message}`);
    }
    const commitSha = this.execGit(["rev-parse", "HEAD"]).trim();
    logger.info({ slug, branch, commitSha }, "Task branch merged into base");
    return { commitSha };
  }
}
