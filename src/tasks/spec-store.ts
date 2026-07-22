import { openDb } from "../db/index.js";
import { getTask, TaskNotFoundError } from "./store.js";
import type { StructuredAcpError } from "../acp/errors.js";

export type SpecMessageRole = "user" | "assistant";

export interface SpecMessage {
  id: number;
  task_id: number;
  role: SpecMessageRole;
  content: string;
  created_at: string;
  prompt_status?: "authentication_required" | null;
  failure?: StructuredAcpError | null;
}

interface SpecMessageRow {
  id: number;
  task_id: number;
  role: string;
  content: string;
  created_at: string;
  prompt_status: string | null;
  failure: string | null;
}

function asRole(value: string): SpecMessageRole {
  return value === "assistant" ? "assistant" : "user";
}

function rowToMessage(row: SpecMessageRow): SpecMessage {
  return { ...row, role: asRole(row.role), prompt_status: row.prompt_status === "authentication_required" ? "authentication_required" : null, failure: row.failure ? JSON.parse(row.failure) as StructuredAcpError : null };
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
       "SELECT id, task_id, role, content, prompt_status, failure, created_at FROM spec_messages WHERE task_id = ? ORDER BY id ASC",
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
    .prepare("SELECT id, task_id, role, content, prompt_status, failure, created_at FROM spec_messages WHERE id = ?")
    .get(id) as SpecMessageRow;
  return rowToMessage(row);
}
export function getSpecMessage(id: number, root?: string): SpecMessage | undefined { const row = openDb(root).prepare("SELECT id, task_id, role, content, prompt_status, failure, created_at FROM spec_messages WHERE id = ?").get(id) as SpecMessageRow | undefined; return row ? rowToMessage(row) : undefined; }
export function markSpecMessageAuthenticationRequired(id: number, failure: StructuredAcpError, root?: string): SpecMessage { openDb(root).prepare("UPDATE spec_messages SET prompt_status = 'authentication_required', failure = ? WHERE id = ? AND role = 'user'").run(JSON.stringify(failure), id); return getSpecMessage(id, root)!; }
export function clearSpecMessagePromptFailure(id: number, root?: string): SpecMessage { openDb(root).prepare("UPDATE spec_messages SET prompt_status = NULL, failure = NULL WHERE id = ? AND role = 'user'").run(id); return getSpecMessage(id, root)!; }
