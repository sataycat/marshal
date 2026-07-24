import { openDb } from "../db/index.js";
import { openRepositoryDb } from "../db/index.js";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { asTaskStatus, assertTransition, isEscapeHatch, type TaskStatus } from "./state-machine.js";

export interface Task {
  id: number;
  slug: string;
  title: string;
  status: TaskStatus;
  spec_markdown: string;
  retry_count: number;
  last_failure: string | null;
  created_at: string;
  updated_at: string;
  repository_id?: string | null;
  workflow_profile_id?: string | null;
}

export interface CreateTaskInput {
  slug: string;
  title: string;
  specMarkdown?: string;
  repositoryId?: string;
  workflowProfileId?: string;
}

export class TaskNotFoundError extends Error {
  constructor(slug: string) {
    super(`Task not found: ${slug}`);
    this.name = "TaskNotFoundError";
  }
}

export class DuplicateSlugError extends Error {
  constructor(slug: string) {
    super(`Task slug already exists: ${slug}`);
    this.name = "DuplicateSlugError";
  }
}

interface TaskRow {
  id: number;
  slug: string;
  title: string;
  status: string;
  spec_markdown: string;
  retry_count: number;
  last_failure: string | null;
  created_at: string;
  updated_at: string;
  repository_id: string | null;
  workflow_profile_id: string | null;
}

function rowToTask(row: TaskRow): Task {
  return { ...row, status: asTaskStatus(row.status) };
}

function scopedDb(repositoryId: string, machineDir?: string) {
  return openRepositoryDb(repositoryId, machineDir);
}

/** Repository-scoped task list. The root overload is retained for pre-Slice-3 unit fixtures. */
export function listTasks(repositoryId?: string, machineDir?: string): Task[] {
  if (!repositoryId || repositoryId.startsWith("/") || repositoryId.startsWith(".")) return (openDb(machineDir ?? repositoryId).prepare("SELECT * FROM tasks ORDER BY created_at DESC, id DESC").all() as TaskRow[]).map(rowToTask);
  const db = scopedDb(repositoryId, machineDir);
  const rows = db
    .prepare("SELECT * FROM tasks WHERE repository_id = ? ORDER BY created_at DESC, id DESC")
    .all(repositoryId) as TaskRow[];
  return rows.map(rowToTask);
}

export function getTask(repositoryId: string, slug: string, machineDir?: string): Task;
export function getTask(slug: string, root?: string): Task;
export function getTask(first: string, second?: string, third?: string): Task {
  const legacy = second === undefined || second.startsWith("/") || second.startsWith(".");
  const repositoryId = legacy ? undefined : first;
  const slug = legacy ? first : second!;
  const db = legacy ? openDb(second) : scopedDb(repositoryId!, third);
  const row = db.prepare(legacy ? "SELECT * FROM tasks WHERE slug = ?" : "SELECT * FROM tasks WHERE repository_id = ? AND slug = ?").get(...(legacy ? [slug] : [repositoryId, slug])) as TaskRow | undefined;
  if (!row) {
    throw new TaskNotFoundError(slug);
  }
  return rowToTask(row);
}

export function createTask(input: CreateTaskInput, root?: string): Task {
  const legacy = !input.repositoryId;
  const db = legacy ? openDb(root) : scopedDb(input.repositoryId!, root);
  let legacyRepositoryId: string | undefined;
  if (legacy) {
    legacyRepositoryId = (db.prepare("SELECT id FROM repositories ORDER BY created_at LIMIT 1").get() as { id: string } | undefined)?.id;
    if (!legacyRepositoryId) {
      legacyRepositoryId = randomUUID();
      const repositoryPath = resolve(root ?? process.cwd());
      db.prepare("INSERT INTO repositories (id, path, name) VALUES (?, ?, ?)").run(legacyRepositoryId, repositoryPath, repositoryPath.split(/[\\/]/).pop() || "repository");
    }
  }
  const existing = db.prepare(legacy ? "SELECT 1 FROM tasks WHERE slug = ?" : "SELECT 1 FROM tasks WHERE repository_id = ? AND slug = ?").get(...(legacy ? [input.slug] : [input.repositoryId, input.slug]));
  if (existing) {
    throw new DuplicateSlugError(input.slug);
  }

  const info = db
    .prepare(legacy ? "INSERT INTO tasks (repository_id, slug, title, spec_markdown, workflow_profile_id) VALUES ((SELECT id FROM repositories ORDER BY created_at LIMIT 1), ?, ?, ?, ?)" : "INSERT INTO tasks (repository_id, slug, title, spec_markdown, workflow_profile_id) VALUES (?, ?, ?, ?, ?)")
    .run(...(legacy ? [input.slug, input.title, input.specMarkdown ?? "", input.workflowProfileId ?? null] : [input.repositoryId, input.slug, input.title, input.specMarkdown ?? "", input.workflowProfileId ?? null]));

  return {
    id: Number(info.lastInsertRowid),
    slug: input.slug,
    title: input.title,
    status: "backlog",
    spec_markdown: input.specMarkdown ?? "",
    retry_count: 0,
    last_failure: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    repository_id: input.repositoryId ?? legacyRepositoryId ?? null,
    workflow_profile_id: input.workflowProfileId ?? null,
  };
}

export function transitionTask(repositoryId: string, slug: string, to: TaskStatus, machineDir?: string): Task;
export function transitionTask(slug: string, to: TaskStatus, root?: string): Task;
export function transitionTask(first: string, second: TaskStatus | string, third?: TaskStatus | string, fourth?: string): Task {
  const legacy = third === undefined || (typeof third === "string" && (third.startsWith("/") || third.startsWith(".")));
  const repositoryId = legacy ? undefined : first;
  const slug = legacy ? first : second as string;
  const to = (legacy ? second : third) as TaskStatus;
  const root = legacy ? third as string | undefined : fourth;
  const db = legacy ? openDb(root) : scopedDb(repositoryId!, root);
  const tx = db.transaction(() => {
  const row = db.prepare(legacy ? "SELECT * FROM tasks WHERE slug = ?" : "SELECT * FROM tasks WHERE repository_id = ? AND slug = ?").get(...(legacy ? [slug] : [repositoryId, slug])) as TaskRow | undefined;
    if (!row) {
      throw new TaskNotFoundError(slug);
    }
    const from = asTaskStatus(row.status);
    assertTransition(from, to);

    if (isEscapeHatch(from, to)) {
      const updated = db
        .prepare(
          legacy ? "UPDATE tasks SET status = ?, retry_count = 0, last_failure = NULL, updated_at = CURRENT_TIMESTAMP WHERE slug = ? RETURNING *" : "UPDATE tasks SET status = ?, retry_count = 0, last_failure = NULL, updated_at = CURRENT_TIMESTAMP WHERE repository_id = ? AND slug = ? RETURNING *",
        )
        .get(...(legacy ? [to, slug] : [to, repositoryId, slug])) as TaskRow | undefined;
      return rowToTask(updated!);
    }

    db.prepare(legacy ? "UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE slug = ?" : "UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE repository_id = ? AND slug = ?").run(...(legacy ? [to, slug] : [to, repositoryId, slug]));
    return rowToTask({ ...row, status: to });
  });

  return tx();
}

export function incrementRetryCount(repositoryId: string, slug: string, lastFailure: string, machineDir?: string): Task;
export function incrementRetryCount(slug: string, lastFailure: string, root?: string): Task;
export function incrementRetryCount(first: string, second: string, third?: string, fourth?: string): Task {
  const legacy = third === undefined || (fourth === undefined && (third.startsWith("/") || third.startsWith(".")));
  const repositoryId = legacy ? undefined : first;
  const slug = legacy ? first : second;
  const lastFailure = legacy ? second : third!;
  const root = legacy ? third : fourth;
  const db = legacy ? openDb(root) : scopedDb(repositoryId!, root);
  const row = db
    .prepare(legacy ? "UPDATE tasks SET retry_count = retry_count + 1, last_failure = ?, updated_at = CURRENT_TIMESTAMP WHERE slug = ? RETURNING *" : "UPDATE tasks SET retry_count = retry_count + 1, last_failure = ?, updated_at = CURRENT_TIMESTAMP WHERE repository_id = ? AND slug = ? RETURNING *")
    .get(...(legacy ? [lastFailure, slug] : [lastFailure, repositoryId, slug])) as TaskRow | undefined;
  if (!row) {
    throw new TaskNotFoundError(slug);
  }
  return rowToTask(row);
}

export function setLastFailure(repositoryId: string, slug: string, lastFailure: string, machineDir?: string): Task;
export function setLastFailure(slug: string, lastFailure: string, root?: string): Task;
export function setLastFailure(first: string, second: string, third?: string, fourth?: string): Task {
  const legacy = third === undefined || (fourth === undefined && (third.startsWith("/") || third.startsWith(".")));
  const repositoryId = legacy ? undefined : first;
  const slug = legacy ? first : second;
  const lastFailure = legacy ? second : third!;
  const root = legacy ? third : fourth;
  const db = legacy ? openDb(root) : scopedDb(repositoryId!, root);
  const row = db
    .prepare(legacy ? "UPDATE tasks SET last_failure = ?, updated_at = CURRENT_TIMESTAMP WHERE slug = ? RETURNING *" : "UPDATE tasks SET last_failure = ?, updated_at = CURRENT_TIMESTAMP WHERE repository_id = ? AND slug = ? RETURNING *")
    .get(...(legacy ? [lastFailure, slug] : [lastFailure, repositoryId, slug])) as TaskRow | undefined;
  if (!row) {
    throw new TaskNotFoundError(slug);
  }
  return rowToTask(row);
}

export function clearRetryState(repositoryId: string, slug: string, machineDir?: string): Task;
export function clearRetryState(slug: string, root?: string): Task;
export function clearRetryState(first: string, second?: string, third?: string): Task {
  const legacy = second === undefined || second.startsWith("/") || second.startsWith(".");
  const repositoryId = legacy ? undefined : first;
  const slug = legacy ? first : second!;
  const db = legacy ? openDb(second) : scopedDb(repositoryId!, third);
  const row = db
    .prepare(legacy ? "UPDATE tasks SET retry_count = 0, last_failure = NULL, updated_at = CURRENT_TIMESTAMP WHERE slug = ? RETURNING *" : "UPDATE tasks SET retry_count = 0, last_failure = NULL, updated_at = CURRENT_TIMESTAMP WHERE repository_id = ? AND slug = ? RETURNING *")
    .get(...(legacy ? [slug] : [repositoryId, slug])) as TaskRow | undefined;
  if (!row) {
    throw new TaskNotFoundError(slug);
  }
  return rowToTask(row);
}

export function setSpecMarkdown(repositoryId: string, slug: string, specMarkdown: string, machineDir?: string): Task;
export function setSpecMarkdown(slug: string, specMarkdown: string, root?: string): Task;
export function setSpecMarkdown(first: string, second: string, third?: string, fourth?: string): Task {
  const legacy = third === undefined || (fourth === undefined && (third.startsWith("/") || third.startsWith(".")));
  const repositoryId = legacy ? undefined : first;
  const slug = legacy ? first : second;
  const specMarkdown = legacy ? second : third!;
  const root = legacy ? third : fourth;
  const db = legacy ? openDb(root) : scopedDb(repositoryId!, root);
  const row = db
    .prepare(legacy ? "UPDATE tasks SET spec_markdown = ?, updated_at = CURRENT_TIMESTAMP WHERE slug = ? RETURNING *" : "UPDATE tasks SET spec_markdown = ?, updated_at = CURRENT_TIMESTAMP WHERE repository_id = ? AND slug = ? RETURNING *")
    .get(...(legacy ? [specMarkdown, slug] : [specMarkdown, repositoryId, slug])) as TaskRow | undefined;
  if (!row) {
    throw new TaskNotFoundError(slug);
  }
  return rowToTask(row);
}
