import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "../logger.js";
import { WorktreeManager } from "../worktree/manager.js";
import { getTask, TaskNotFoundError } from "./store.js";

export class FreezeError extends Error {
  constructor(slug: string, message: string) {
    super(`Cannot freeze task ${slug}: ${message}`);
    this.name = "FreezeError";
  }
}

export interface FreezeResult {
  slug: string;
  branch: string;
  worktreePath: string;
  specPath: string;
  specRelPath: string;
  commitSha: string;
}

function padTaskId(id: number): string {
  return String(id).padStart(4, "0");
}

function renderSpec(slug: string, title: string, taskId: number, specMarkdown: string): string {
  const frozenAt = new Date().toISOString();
  const frontMatter = [
    "---",
    `slug: ${slug}`,
    `title: ${JSON.stringify(title)}`,
    `task_id: ${taskId}`,
    `frozen_at: ${frozenAt}`,
    "---",
    "",
  ].join("\n");
  return `${frontMatter}${specMarkdown.trimEnd()}\n`;
}

function gitInWorktree(worktreePath: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: worktreePath,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function specRelPathFor(slug: string, taskId: number): string {
  const safeSlug = slug
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.\.+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "") || "task";
  return `specs/${padTaskId(taskId)}-${safeSlug}.md`;
}

export function freezeTask(
  repositoryId: string,
  slug: string,
  root?: string,
  manager?: WorktreeManager,
  machineDir?: string,
): FreezeResult;
export function freezeTask(
  slug: string,
  root?: string,
  manager?: WorktreeManager,
): FreezeResult;
export function freezeTask(
  first: string,
  second?: string | WorktreeManager,
  third?: string | WorktreeManager,
  fourth?: WorktreeManager,
  fifth?: string,
): FreezeResult {
  const scoped = fourth !== undefined || (typeof second === "string" && typeof third === "string");
  const repositoryId = scoped ? first : undefined;
  const slug = scoped ? second as string : first;
  const root = scoped ? (third as string | undefined) : second as string | undefined;
  const manager = scoped ? fourth ?? (third instanceof WorktreeManager ? third : undefined) : second instanceof WorktreeManager ? second : third instanceof WorktreeManager ? third : undefined;
  const machineDir = scoped ? fifth : undefined;
  const task = (() => {
    try {
      return repositoryId ? getTask(repositoryId, slug, machineDir) : getTask(slug, root);
    } catch (err) {
      if (err instanceof TaskNotFoundError) {
        throw new FreezeError(slug, "task not found");
      }
      throw err;
    }
  })();

  if (task.status !== "ready") {
    throw new FreezeError(slug, `task is in '${task.status}', must be 'ready'`);
  }

  if (!task.spec_markdown || task.spec_markdown.trim().length === 0) {
    throw new FreezeError(slug, "spec is empty (provide --spec or --spec-file at create time)");
  }

  const mgr = manager ?? new WorktreeManager(task.repository_id ?? repositoryId ?? "", root ?? process.cwd());
  const worktree = mgr.create(slug);

  const specRel = specRelPathFor(slug, task.id);
  const specAbs = resolve(worktree.path, specRel);
  mkdirSync(resolve(worktree.path, "specs"), { recursive: true });

  const rendered = renderSpec(slug, task.title, task.id, task.spec_markdown);
  writeFileSync(specAbs, rendered);

  gitInWorktree(worktree.path, ["add", "--", specRel]);

  const status = gitInWorktree(worktree.path, ["status", "--porcelain=v1"]).trim();
  const hasStaged = status.split("\n").some((line) => line.startsWith("M ") || line.startsWith("A "));
  const commitMessage = `freeze: ${slug}`;
  let commitSha: string;

  if (hasStaged) {
    gitInWorktree(worktree.path, ["commit", "-m", commitMessage]);
  } else {
    if (!existsSync(specAbs)) {
      throw new FreezeError(slug, "failed to stage spec file for commit");
    }
    const tracked = gitInWorktree(worktree.path, ["ls-files", "--", specRel]).trim().length > 0;
    if (tracked) {
      logger.info({ slug, specRel }, "Spec already frozen; reusing commit");
    } else {
      gitInWorktree(worktree.path, ["commit", "--allow-empty", "-m", commitMessage]);
    }
  }
  commitSha = gitInWorktree(worktree.path, ["rev-parse", "HEAD"]).trim();

  logger.info({ slug, branch: worktree.branch, specRel, commitSha }, "Spec frozen");

  return {
    slug,
    branch: worktree.branch,
    worktreePath: worktree.path,
    specPath: specAbs,
    specRelPath: specRel,
    commitSha,
  };
}
