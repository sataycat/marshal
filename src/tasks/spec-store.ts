import { openDb } from "../db/index.js";
import { getTask, TaskNotFoundError } from "./store.js";

export type SpecMessageRole = "user" | "assistant";

export interface SpecMessage {
  id: number;
  task_id: number;
  role: SpecMessageRole;
  content: string;
  created_at: string;
}

interface SpecMessageRow {
  id: number;
  task_id: number;
  role: string;
  content: string;
  created_at: string;
}

function asRole(value: string): SpecMessageRole {
  return value === "assistant" ? "assistant" : "user";
}

function rowToMessage(row: SpecMessageRow): SpecMessage {
  return { ...row, role: asRole(row.role) };
}

export function listSpecMessages(slug: string, root?: string): SpecMessage[] {
  const db = openDb(root);
  const task = (() => {
    try {
      return getTask(slug, root);
    } catch (err) {
      if (err instanceof TaskNotFoundError) {
        throw err;
      }
      throw err;
    }
  })();
  const rows = db
    .prepare(
      "SELECT id, task_id, role, content, created_at FROM spec_messages WHERE task_id = ? ORDER BY id ASC",
    )
    .all(task.id) as SpecMessageRow[];
  return rows.map(rowToMessage);
}

export function appendSpecMessage(
  slug: string,
  role: SpecMessageRole,
  content: string,
  root?: string,
): SpecMessage {
  const db = openDb(root);
  const task = getTask(slug, root);
  const info = db
    .prepare("INSERT INTO spec_messages (task_id, role, content) VALUES (?, ?, ?)")
    .run(task.id, role, content);
  const id = Number(info.lastInsertRowid);
  const row = db
    .prepare("SELECT id, task_id, role, content, created_at FROM spec_messages WHERE id = ?")
    .get(id) as SpecMessageRow;
  return rowToMessage(row);
}
