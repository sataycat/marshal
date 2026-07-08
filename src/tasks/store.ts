import { openDb } from "../db/index.js";
import { asTaskStatus, assertTransition, type TaskStatus } from "./state-machine.js";

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
}

export interface CreateTaskInput {
  slug: string;
  title: string;
  specMarkdown?: string;
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
}

function rowToTask(row: TaskRow): Task {
  return { ...row, status: asTaskStatus(row.status) };
}

export function listTasks(root?: string): Task[] {
  const db = openDb(root);
  const rows = db
    .prepare("SELECT * FROM tasks ORDER BY created_at DESC, id DESC")
    .all() as TaskRow[];
  return rows.map(rowToTask);
}

export function getTask(slug: string, root?: string): Task {
  const db = openDb(root);
  const row = db.prepare("SELECT * FROM tasks WHERE slug = ?").get(slug) as TaskRow | undefined;
  if (!row) {
    throw new TaskNotFoundError(slug);
  }
  return rowToTask(row);
}

export function createTask(input: CreateTaskInput, root?: string): Task {
  const db = openDb(root);
  const existing = db.prepare("SELECT 1 FROM tasks WHERE slug = ?").get(input.slug);
  if (existing) {
    throw new DuplicateSlugError(input.slug);
  }

  const info = db
    .prepare("INSERT INTO tasks (slug, title, spec_markdown) VALUES (?, ?, ?)")
    .run(input.slug, input.title, input.specMarkdown ?? "");

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
  };
}

export function transitionTask(slug: string, to: TaskStatus, root?: string): Task {
  const db = openDb(root);
  const tx = db.transaction(() => {
    const row = db.prepare("SELECT * FROM tasks WHERE slug = ?").get(slug) as TaskRow | undefined;
    if (!row) {
      throw new TaskNotFoundError(slug);
    }
    const from = asTaskStatus(row.status);
    assertTransition(from, to);

    db.prepare("UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE slug = ?").run(
      to,
      slug,
    );
    return rowToTask({ ...row, status: to });
  });

  return tx();
}

export function incrementRetryCount(slug: string, lastFailure: string, root?: string): Task {
  const db = openDb(root);
  const row = db
    .prepare(
      "UPDATE tasks SET retry_count = retry_count + 1, last_failure = ?, updated_at = CURRENT_TIMESTAMP WHERE slug = ? RETURNING *",
    )
    .get(lastFailure, slug) as TaskRow | undefined;
  if (!row) {
    throw new TaskNotFoundError(slug);
  }
  return rowToTask(row);
}

export function setLastFailure(slug: string, lastFailure: string, root?: string): Task {
  const db = openDb(root);
  const row = db
    .prepare(
      "UPDATE tasks SET last_failure = ?, updated_at = CURRENT_TIMESTAMP WHERE slug = ? RETURNING *",
    )
    .get(lastFailure, slug) as TaskRow | undefined;
  if (!row) {
    throw new TaskNotFoundError(slug);
  }
  return rowToTask(row);
}

export function clearRetryState(slug: string, root?: string): Task {
  const db = openDb(root);
  const row = db
    .prepare(
      "UPDATE tasks SET retry_count = 0, last_failure = NULL, updated_at = CURRENT_TIMESTAMP WHERE slug = ? RETURNING *",
    )
    .get(slug) as TaskRow | undefined;
  if (!row) {
    throw new TaskNotFoundError(slug);
  }
  return rowToTask(row);
}
