import { openDb } from "../db/index.js";
import { openRepositoryDb } from "../db/index.js";
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

export function listSpecMessages(repositoryId: string, slug: string, machineDir?: string): SpecMessage[];
export function listSpecMessages(slug: string, root?: string): SpecMessage[];
export function listSpecMessages(first: string, second?: string, third?: string): SpecMessage[] {
  const scoped = second !== undefined && third !== undefined;
  const slug = scoped ? second! : first;
  const db = scoped ? openRepositoryDb(first, third) : openDb(second);
  const task = (() => {
    try {
      return scoped ? getTask(first, slug, third) : getTask(slug, second);
    } catch (err) {
      if (err instanceof TaskNotFoundError) {
        throw err;
      }
      throw err;
    }
  })();
  const rows = db
    .prepare(
       scoped ? "SELECT id, task_id, role, content, prompt_status, failure, created_at FROM spec_messages WHERE repository_id = ? AND task_id = ? ORDER BY id ASC" : "SELECT id, task_id, role, content, prompt_status, failure, created_at FROM spec_messages WHERE task_id = ? ORDER BY id ASC",
    )
    .all(...(scoped ? [first, task.id] : [task.id])) as SpecMessageRow[];
  return rows.map(rowToMessage);
}

export function appendSpecMessage(repositoryId: string, slug: string, role: SpecMessageRole, content: string, machineDir?: string): SpecMessage;
export function appendSpecMessage(slug: string, role: SpecMessageRole, content: string, root?: string): SpecMessage;
export function appendSpecMessage(first: string, second: string, third: string, fourth?: string, fifth?: string): SpecMessage {
  const scoped = fifth !== undefined;
  const repositoryId = scoped ? first : undefined;
  const slug = scoped ? second : first;
  const role = (scoped ? third : second) as SpecMessageRole;
  const content = scoped ? fourth! : third;
  const db = scoped ? openRepositoryDb(repositoryId!, fifth) : openDb(fourth);
  const task = scoped ? getTask(repositoryId!, slug, fifth) : getTask(slug, fourth);
  const info = db
    .prepare(scoped ? "INSERT INTO spec_messages (task_id, repository_id, role, content) VALUES (?, ?, ?, ?)" : "INSERT INTO spec_messages (task_id, role, content) VALUES (?, ?, ?)")
    .run(...(scoped ? [task.id, repositoryId, role, content] : [task.id, role, content]));
  const id = Number(info.lastInsertRowid);
  const row = db
    .prepare(scoped ? "SELECT id, task_id, role, content, prompt_status, failure, created_at FROM spec_messages WHERE repository_id = ? AND id = ?" : "SELECT id, task_id, role, content, prompt_status, failure, created_at FROM spec_messages WHERE id = ?")
    .get(...(scoped ? [repositoryId, id] : [id])) as SpecMessageRow;
  return rowToMessage(row);
}
export function getSpecMessage(repositoryId: string, id: number, machineDir?: string): SpecMessage | undefined;
export function getSpecMessage(id: number, root?: string): SpecMessage | undefined;
export function getSpecMessage(first: string | number, second?: number | string, third?: string): SpecMessage | undefined { const scoped = typeof first === "string"; const id = scoped ? second as number : first; const db = scoped ? openRepositoryDb(first, third) : openDb(second as string | undefined); const row = db.prepare(scoped ? "SELECT id, task_id, role, content, prompt_status, failure, created_at FROM spec_messages WHERE repository_id = ? AND id = ?" : "SELECT id, task_id, role, content, prompt_status, failure, created_at FROM spec_messages WHERE id = ?").get(...(scoped ? [first, id] : [id])) as SpecMessageRow | undefined; return row ? rowToMessage(row) : undefined; }
export function markSpecMessageAuthenticationRequired(repositoryId: string, id: number, failure: StructuredAcpError, machineDir?: string): SpecMessage;
export function markSpecMessageAuthenticationRequired(id: number, failure: StructuredAcpError, root?: string): SpecMessage;
export function markSpecMessageAuthenticationRequired(first: string | number, second: number | StructuredAcpError, third?: StructuredAcpError | string, fourth?: string): SpecMessage { const scoped = typeof first === "string"; const id = scoped ? second as number : first; const failure = (scoped ? third : second) as StructuredAcpError; const db = scoped ? openRepositoryDb(first, fourth) : openDb(third as string | undefined); db.prepare(scoped ? "UPDATE spec_messages SET prompt_status = 'authentication_required', failure = ? WHERE repository_id = ? AND id = ? AND role = 'user'" : "UPDATE spec_messages SET prompt_status = 'authentication_required', failure = ? WHERE id = ? AND role = 'user'").run(...(scoped ? [JSON.stringify(failure), first, id] : [JSON.stringify(failure), id])); return scoped ? getSpecMessage(first, id, fourth)! : getSpecMessage(id, third as string | undefined)!; }
export function clearSpecMessagePromptFailure(repositoryId: string, id: number, machineDir?: string): SpecMessage;
export function clearSpecMessagePromptFailure(id: number, root?: string): SpecMessage;
export function clearSpecMessagePromptFailure(first: string | number, second?: number | string, third?: string): SpecMessage { const scoped = typeof first === "string"; const id = scoped ? second as number : first; const db = scoped ? openRepositoryDb(first, third) : openDb(second as string | undefined); db.prepare(scoped ? "UPDATE spec_messages SET prompt_status = NULL, failure = NULL WHERE repository_id = ? AND id = ? AND role = 'user'" : "UPDATE spec_messages SET prompt_status = NULL, failure = NULL WHERE id = ? AND role = 'user'").run(...(scoped ? [first, id] : [id])); return scoped ? getSpecMessage(first, id, third)! : getSpecMessage(id, second as string | undefined)!; }
