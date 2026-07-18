import { randomUUID } from "node:crypto";
import { openDb } from "../db/index.js";

export interface SpecAuthorSession {
  id: string; task_id: number; repository_id: string; workflow_profile_id: string;
  assignment_id: string; agent_id: string; agent_version: string; capabilities: unknown;
  assignment_config: unknown; acp_session_id: string | null; supervisor_session_id: string | null;
  status: string; created_at: string; updated_at: string;
}
export interface SpecAuthorOperation { id: number; author_session_id: string; operation: string; status: string; diagnostic: string | null; created_at: string }
const parse = (value: unknown): unknown => { try { return JSON.parse(String(value)); } catch { return value; } };
function map(row: Record<string, unknown>): SpecAuthorSession { return { ...(row as unknown as SpecAuthorSession), capabilities: parse(row.capabilities), assignment_config: parse(row.assignment_config) }; }
export function createSpecAuthorSession(input: { taskId: number; repositoryId: string; workflowProfileId: string; assignmentId: string; agentId: string; agentVersion: string; assignmentConfig: unknown }, root?: string): SpecAuthorSession {
  const id = randomUUID();
  openDb(root).prepare("INSERT INTO spec_author_sessions (id, task_id, repository_id, workflow_profile_id, assignment_id, agent_id, agent_version, assignment_config) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, input.taskId, input.repositoryId, input.workflowProfileId, input.assignmentId, input.agentId, input.agentVersion, JSON.stringify(input.assignmentConfig ?? {}));
  return getSpecAuthorSession(id, root)!;
}
export function getSpecAuthorSession(id: string, root?: string): SpecAuthorSession | undefined { const row = openDb(root).prepare("SELECT * FROM spec_author_sessions WHERE id = ?").get(id) as Record<string, unknown> | undefined; return row ? map(row) : undefined; }
export function listSpecAuthorSessions(taskId: number, root?: string): SpecAuthorSession[] { return (openDb(root).prepare("SELECT * FROM spec_author_sessions WHERE task_id = ? ORDER BY created_at").all(taskId) as Record<string, unknown>[]).map(map); }
export function updateSpecAuthorSession(id: string, input: { supervisorSessionId?: string | null; acpSessionId?: string | null; capabilities?: unknown; status?: string }, root?: string): SpecAuthorSession { const current = getSpecAuthorSession(id, root); if (!current) throw new Error("Spec author session not found"); openDb(root).prepare("UPDATE spec_author_sessions SET supervisor_session_id = ?, acp_session_id = ?, capabilities = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(input.supervisorSessionId === undefined ? current.supervisor_session_id : input.supervisorSessionId, input.acpSessionId === undefined ? current.acp_session_id : input.acpSessionId, JSON.stringify(input.capabilities ?? current.capabilities), input.status ?? current.status, id); return getSpecAuthorSession(id, root)!; }
export function appendSpecAuthorOperation(sessionId: string, operation: string, status: string, diagnostic: string | null = null, root?: string): SpecAuthorOperation { const db = openDb(root); const info = db.prepare("INSERT INTO spec_author_operations (author_session_id, operation, status, diagnostic) VALUES (?, ?, ?, ?)").run(sessionId, operation, status, diagnostic); return db.prepare("SELECT * FROM spec_author_operations WHERE id = ?").get(Number(info.lastInsertRowid)) as SpecAuthorOperation; }
export function listSpecAuthorOperations(sessionId: string, root?: string): SpecAuthorOperation[] { return openDb(root).prepare("SELECT * FROM spec_author_operations WHERE author_session_id = ? ORDER BY id").all(sessionId) as SpecAuthorOperation[]; }
