import { randomUUID } from "node:crypto";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";
import { getGlobalDir } from "../daemon/config.js";
import { openMachineDb } from "../storage/machine.js";
import { ensureRepositoryNamespace } from "../storage/layout.js";
import { logger } from "../logger.js";
import { loadMarshalJson } from "./config.js";
import { copyWorktreeIncludes } from "./include.js";
import { branchNameForSlug, descriptorForSlug } from "./name.js";
import {
  DiffError,
  type DiffResult,
  MergeError,
  type MergeResult,
  parseDiffStats,
} from "./diff-merge.js";

export type WorktreeStatus = "creating" | "ready" | "destroying" | "failed";

export interface WorktreeInfo {
  id: string;
  repositoryId: string;
  slug: string;
  branch: string;
  path: string;
  descriptor: string;
  sourceCheckout: string;
  status: WorktreeStatus;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

interface WorktreeRow {
  id: string;
  repository_id: string;
  task_slug: string;
  branch: string;
  descriptor: string;
  source_checkout: string;
  worktree_path: string;
  status: WorktreeStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorktreeManagerOptions {
  /** MARSHAL_HOME. Kept separate from the source checkout deliberately. */
  machineDir?: string;
}

function rowToInfo(row: WorktreeRow): WorktreeInfo {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    slug: row.task_slug,
    branch: row.branch,
    path: row.worktree_path,
    descriptor: row.descriptor,
    sourceCheckout: row.source_checkout,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.error ? { error: row.error } : {}),
  };
}

/** Owns task worktrees in the daemon database and repository namespace. */
export class WorktreeManager {
  readonly repositoryId: string;
  readonly sourcePath: string;
  readonly worktreeRoot: string;
  private readonly machineDir: string;

  constructor(repositoryId: string, sourcePath: string, options: WorktreeManagerOptions = {}) {
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

    this.machineDir = options.machineDir ?? getGlobalDir();
    this.sourcePath = resolve(topLevel);
    this.repositoryId = repositoryId;
    if (!this.repositoryId || this.repositoryId.trim().length === 0) {
      throw new Error("Repository ID is required for WorktreeManager");
    }

    // Direct manager fixtures may not have gone through repository registration.
    // Materialize only the explicit identity needed by the foreign key; normal
    // daemon/API flows already have this row.
    this.ensureRepositoryRecord();
    const namespace = ensureRepositoryNamespace(this.repositoryId, this.machineDir);
    this.worktreeRoot = namespace.worktreesDirectory;
    this.recoverRecords();
  }

  private db() {
    return openMachineDb(this.machineDir);
  }

  private ensureRepositoryRecord(): void {
    const db = this.db();
    const existing = db.prepare("SELECT id FROM repositories WHERE id = ?").get(this.repositoryId);
    if (existing) {
      const conflicting = db
        .prepare("SELECT id FROM repositories WHERE path = ? AND id <> ?")
        .get(this.sourcePath, this.repositoryId) as { id: string } | undefined;
      if (conflicting) throw new Error(`Checkout is registered under repository ID ${conflicting.id}, not ${this.repositoryId}`);
      // A repository ID survives checkout relocation. The source path remains
      // execution metadata and is refreshed whenever the manager reconnects.
      db.prepare("UPDATE repositories SET path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(this.sourcePath, this.repositoryId);
      return;
    }
    const byPath = db.prepare("SELECT id FROM repositories WHERE path = ?").get(this.sourcePath) as
      | { id: string }
      | undefined;
    if (byPath && byPath.id !== this.repositoryId) {
      // Explicit IDs are authoritative. This is normally only reachable from
      // a test or recovery seam, and must not silently alias two repositories.
      throw new Error(`Checkout is registered under repository ID ${byPath.id}, not ${this.repositoryId}`);
    }
    db.prepare("INSERT INTO repositories (id, path, name) VALUES (?, ?, ?)").run(
      this.repositoryId,
      this.sourcePath,
      basename(this.sourcePath) || "repository",
    );
  }

  private rows(includeFailed = true): WorktreeRow[] {
    const db = this.db();
    return (db
      .prepare(
        `SELECT id, repository_id, task_slug, branch, descriptor, source_checkout,
                worktree_path, status, error, created_at, updated_at
           FROM worktrees
          WHERE repository_id = ?${includeFailed ? "" : " AND status = 'ready'"}
          ORDER BY created_at, id`,
      )
      .all(this.repositoryId) as WorktreeRow[]);
  }

  private update(id: string, status: WorktreeStatus, error: string | null = null): void {
    this.db()
      .prepare("UPDATE worktrees SET status = ?, error = ?, source_checkout = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND repository_id = ?")
      .run(status, error, this.sourcePath, id, this.repositoryId);
  }

  private recoverRecords(): void {
    for (const record of this.rows()) {
      if (record.source_checkout !== this.sourcePath && existsSync(record.worktree_path)) {
        try {
          this.execGit(["worktree", "repair", record.worktree_path]);
        } catch (err) {
          logger.warn({ err, path: record.worktree_path }, "Failed to repair relocated worktree");
        }
      }
      if (record.source_checkout !== this.sourcePath) {
        this.db()
          .prepare("UPDATE worktrees SET source_checkout = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND repository_id = ?")
          .run(this.sourcePath, record.id, this.repositoryId);
      }
      if (record.status === "creating") {
        if (existsSync(record.worktree_path) && this.isGitWorktree(record.worktree_path)) {
          this.update(record.id, "ready");
          continue;
        }
        this.removePartial(record);
        this.update(record.id, "failed", "worktree creation was interrupted before publication");
      } else if (record.status === "destroying") {
        this.removePartial(record);
        this.db().prepare("DELETE FROM worktrees WHERE id = ? AND repository_id = ?").run(record.id, this.repositoryId);
      } else if (record.status === "ready" && !existsSync(record.worktree_path)) {
        this.update(record.id, "failed", "worktree directory is missing");
      }
    }
  }

  private isGitWorktree(path: string): boolean {
    try {
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: path,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return true;
    } catch {
      return false;
    }
  }

  private removePartial(record: WorktreeRow): void {
    if (existsSync(record.worktree_path)) {
      try {
        this.execGit(["worktree", "remove", "--force", record.worktree_path]);
      } catch {
        rmSync(record.worktree_path, { recursive: true, force: true });
      }
    }
    // The directory may have been removed out-of-band. Prune Git's stale
    // worktree administrative entry before deleting its still-associated
    // branch, otherwise Git quite correctly considers the branch checked out.
    try {
      this.execGit(["worktree", "prune"]);
    } catch {
      // Best effort during recovery and explicit cleanup.
    }
    try {
      this.execGit(["branch", "-D", record.branch]);
    } catch {
      // Branch removal is best effort during recovery.
    }
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
    const existing = new Set(this.rows().map((w) => w.descriptor));
    let attempt = 0;
    let descriptor: string;
    do {
      descriptor = descriptorForSlug(slug, attempt++);
    } while (existing.has(descriptor) && attempt < 100);
    return descriptor;
  }

  private runSetupScript(worktreePath: string, branch: string, slug: string): void {
    const setup = loadMarshalJson(this.sourcePath).worktree?.setup;
    if (!setup || setup.trim().length === 0) return;
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
    if (!slug || slug.trim().length === 0) throw new Error("Task slug is required");
    this.recoverRecords();
    this.ensureCleanEnough();

    const existing = this.rows().find((w) => w.task_slug === slug && w.status === "ready");
    if (existing && existsSync(existing.worktree_path)) {
      this.update(existing.id, "ready");
      logger.info({ slug, path: existing.worktree_path }, "Reusing existing worktree");
      return rowToInfo({ ...existing, source_checkout: this.sourcePath, status: "ready" });
    }
    // A failed or missing record is inspectable until the next create, when it
    // is safely retired and replaced by a fresh daemon-generated identity.
    for (const stale of this.rows().filter((w) => w.task_slug === slug && w.status !== "ready")) {
      this.removePartial(stale);
      this.db().prepare("DELETE FROM worktrees WHERE id = ? AND repository_id = ?").run(stale.id, this.repositoryId);
    }
    if (existing) {
      this.removePartial(existing);
      this.db().prepare("DELETE FROM worktrees WHERE id = ? AND repository_id = ?").run(existing.id, this.repositoryId);
    }

    const id = randomUUID();
    const descriptor = this.resolveDescriptor(slug);
    const branch = branchNameForSlug(slug, descriptor);
    const worktreePath = resolve(this.worktreeRoot, id);
    mkdirSync(this.worktreeRoot, { recursive: true });
    this.db()
      .prepare(
        `INSERT INTO worktrees
          (id, repository_id, task_slug, branch, descriptor, source_checkout, worktree_path, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'creating')`,
      )
      .run(id, this.repositoryId, slug, branch, descriptor, this.sourcePath, worktreePath);

    const record = (): WorktreeRow => this.db().prepare("SELECT * FROM worktrees WHERE id = ? AND repository_id = ?").get(id, this.repositoryId) as WorktreeRow;
    try {
      this.execGit(["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
      try {
        copyWorktreeIncludes(this.sourcePath, worktreePath);
      } catch (err) {
        logger.warn({ err }, "Failed to copy .worktreeinclude files");
      }
      this.runSetupScript(worktreePath, branch, slug);
      this.update(id, "ready");
      const info = rowToInfo(record());
      logger.info({ slug, branch, path: worktreePath }, "Worktree created");
      return info;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.removePartial(record());
      this.update(id, "failed", message);
      throw err instanceof Error ? err : new Error(message);
    }
  }

  inspect(slug: string): WorktreeInfo | undefined {
    const row = this.rows().find((candidate) => candidate.task_slug === slug);
    return row ? rowToInfo(row) : undefined;
  }

  destroy(slug: string): void {
    const record = this.rows().find((w) => w.task_slug === slug);
    if (!record) throw new Error(`No worktree found for task: ${slug}`);
    this.update(record.id, "destroying");
    this.removePartial(record);
    this.db().prepare("DELETE FROM worktrees WHERE id = ? AND repository_id = ?").run(record.id, this.repositoryId);
    logger.info({ slug, branch: record.branch }, "Worktree destroyed");
  }

  list(): WorktreeInfo[] {
    return this.rows(false).map(rowToInfo);
  }

  resolveTaskBranch(slug: string): string | undefined {
    return this.rows(false).find((w) => w.task_slug === slug)?.branch;
  }

  diffForSlug(slug: string): DiffResult {
    const record = this.rows(false).find((w) => w.task_slug === slug);
    if (!record) throw new DiffError(slug, "no worktree for task");
    const diff = this.execGit(["diff", `HEAD...${record.branch}`]);
    return { diff, stats: parseDiffStats(diff) };
  }

  mergeTaskBranch(slug: string): MergeResult {
    const record = this.rows(false).find((w) => w.task_slug === slug);
    if (!record) throw new MergeError(slug, "no worktree for task");
    const headBranch = this.execGit(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    if (headBranch === "HEAD") throw new MergeError(slug, "source checkout is in detached HEAD state");
    const status = this.execGit(["status", "--porcelain=v1"]).trim();
    const dirty = status
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("?? "));
    if (dirty.length > 0) throw new MergeError(slug, "source checkout has uncommitted changes; refusing to merge");
    try {
      this.execGit(["merge", "--no-ff", record.branch, "-m", `merge: ${slug}`]);
    } catch (err) {
      try { this.execGit(["merge", "--abort"]); } catch { /* ignore */ }
      const stderr = (err as { stderr?: string }).stderr ?? (err as Error).message;
      if (/CONFLICT|conflict/i.test(stderr)) throw new MergeError(slug, "merge conflict; resolve manually and retry");
      throw new MergeError(slug, `git merge failed: ${(err as Error).message}`);
    }
    const commitSha = this.execGit(["rev-parse", "HEAD"]).trim();
    logger.info({ slug, branch: record.branch, commitSha }, "Task branch merged into base");
    return { commitSha };
  }
}

/** Reconcile all worktree records whose registered checkout is available. */
export function reconcileWorktrees(machineDir = getGlobalDir()): void {
  const db = openMachineDb(machineDir);
  const repositories = db.prepare("SELECT id, path FROM repositories").all() as Array<{ id: string; path: string }>;
  for (const repository of repositories) {
    if (!existsSync(repository.path)) continue;
    try {
      new WorktreeManager(repository.id, repository.path, { machineDir });
    } catch (err) {
      logger.warn({ err, repositoryId: repository.id }, "Failed to reconcile repository worktrees");
    }
  }
}
