import { randomUUID } from "node:crypto";
import { openDb, openRepositoryDb } from "../db/index.js";
import type { HistoricalAgentProvenance } from "../agents/provenance.js";
import type { StructuredAcpError } from "../acp/errors.js";

export interface SpecAuthorSession {
  id: string;
  task_id: number;
  repository_id: string;
  workflow_profile_id: string;
  assignment_id: string;
  agent_id: string;
  agent_version: string;
  agent_provenance: HistoricalAgentProvenance;
  capabilities: unknown;
  assignment_config: unknown;
  acp_session_id: string | null;
  supervisor_session_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  failure: StructuredAcpError | null;
  message_id: number | null;
}

export interface SpecAuthorOperation {
  id: number;
  repository_id?: string;
  author_session_id: string;
  operation: string;
  status: string;
  diagnostic: string | null;
  failure: StructuredAcpError | null;
  created_at: string;
}

const parse = (value: unknown): unknown => {
  try { return JSON.parse(String(value)); } catch { return value; }
};

function map(row: Record<string, unknown>): SpecAuthorSession {
  return {
    ...(row as unknown as SpecAuthorSession),
    repository_id: String(row.repository_id),
    agent_provenance: parse(row.agent_provenance) as HistoricalAgentProvenance,
    capabilities: parse(row.capabilities),
    assignment_config: parse(row.assignment_config),
    failure: row.failure ? parse(row.failure) as StructuredAcpError : null,
  };
}

function mapOperation(row: Record<string, unknown>): SpecAuthorOperation {
  return { ...(row as unknown as SpecAuthorOperation), failure: row.failure ? parse(row.failure) as StructuredAcpError : null };
}

export function createSpecAuthorSession(input: { taskId: number; repositoryId: string; workflowProfileId: string; assignmentId: string; agentId: string; agentVersion: string; agentProvenance?: HistoricalAgentProvenance; assignmentConfig: unknown; messageId?: number }, machineDir?: string): SpecAuthorSession {
  const id = randomUUID();
  const database = openRepositoryDb(input.repositoryId, machineDir);
  database
    .prepare("INSERT INTO spec_author_sessions (id, repository_id, task_id, workflow_profile_id, assignment_id, agent_id, agent_version, agent_provenance, assignment_config, message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
     .run(id, input.repositoryId, input.taskId, input.workflowProfileId, input.assignmentId, input.agentId, input.agentVersion, JSON.stringify(input.agentProvenance ?? {}), JSON.stringify(input.assignmentConfig ?? {}), input.messageId ?? null);
  return getSpecAuthorSession(input.repositoryId, id, machineDir)!;
}

export function getSpecAuthorSession(repositoryId: string, id: string, machineDir?: string): SpecAuthorSession | undefined;
export function getSpecAuthorSession(id: string, root?: string): SpecAuthorSession | undefined;
export function getSpecAuthorSession(first: string, second?: string, third?: string): SpecAuthorSession | undefined {
  const scoped = second !== undefined && third !== undefined;
  const id = scoped ? second! : first;
  const db = scoped ? openRepositoryDb(first, third) : openDb(second);
  const row = db.prepare(scoped ? "SELECT * FROM spec_author_sessions WHERE repository_id = ? AND id = ?" : "SELECT * FROM spec_author_sessions WHERE id = ?").get(...(scoped ? [first, id] : [id])) as Record<string, unknown> | undefined;
  return row ? map(row) : undefined;
}

export function listSpecAuthorSessions(repositoryId: string, taskId: number, machineDir?: string): SpecAuthorSession[];
export function listSpecAuthorSessions(taskId: number, root?: string): SpecAuthorSession[];
export function listSpecAuthorSessions(first: string | number, second?: number | string, third?: string): SpecAuthorSession[] {
  const scoped = typeof first === "string";
  const db = scoped ? openRepositoryDb(first, third) : openDb(second as string | undefined);
  const rows = db.prepare(scoped ? "SELECT * FROM spec_author_sessions WHERE repository_id = ? AND task_id = ? ORDER BY created_at" : "SELECT * FROM spec_author_sessions WHERE task_id = ? ORDER BY created_at").all(...(scoped ? [first, second] : [first])) as Record<string, unknown>[];
  return rows.map(map);
}

type SessionUpdate = { supervisorSessionId?: string | null; acpSessionId?: string | null; capabilities?: unknown; status?: string; failure?: StructuredAcpError | null };

export function updateSpecAuthorSession(repositoryId: string, id: string, input: SessionUpdate, machineDir?: string): SpecAuthorSession;
export function updateSpecAuthorSession(id: string, input: SessionUpdate, root?: string): SpecAuthorSession;
export function updateSpecAuthorSession(first: string, second: string | SessionUpdate, third?: SessionUpdate | string, fourth?: string): SpecAuthorSession {
  const scoped = typeof second === "string";
  const repositoryId = scoped ? first : undefined;
  const id = scoped ? second : first;
  const input = (scoped ? third : second) as SessionUpdate;
  const machineDir = scoped ? fourth : third as string | undefined;
  const current = scoped ? getSpecAuthorSession(repositoryId!, id, machineDir) : getSpecAuthorSession(id, machineDir);
  if (!current) throw new Error("Spec author session not found");
  const db = scoped ? openRepositoryDb(repositoryId!, machineDir) : openDb(machineDir);
  db.prepare(scoped ? "UPDATE spec_author_sessions SET supervisor_session_id = ?, acp_session_id = ?, capabilities = ?, status = ?, failure = ?, updated_at = CURRENT_TIMESTAMP WHERE repository_id = ? AND id = ?" : "UPDATE spec_author_sessions SET supervisor_session_id = ?, acp_session_id = ?, capabilities = ?, status = ?, failure = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(...(scoped ? [input.supervisorSessionId ?? current.supervisor_session_id, input.acpSessionId ?? current.acp_session_id, JSON.stringify(input.capabilities ?? current.capabilities), input.status ?? current.status, input.failure === undefined ? current.failure ? JSON.stringify(current.failure) : null : input.failure ? JSON.stringify(input.failure) : null, repositoryId, id] : [input.supervisorSessionId ?? current.supervisor_session_id, input.acpSessionId ?? current.acp_session_id, JSON.stringify(input.capabilities ?? current.capabilities), input.status ?? current.status, input.failure === undefined ? current.failure ? JSON.stringify(current.failure) : null : input.failure ? JSON.stringify(input.failure) : null, id]));
  return scoped ? getSpecAuthorSession(repositoryId!, id, machineDir)! : getSpecAuthorSession(id, machineDir)!;
}

export function appendSpecAuthorOperation(repositoryId: string, sessionId: string, operation: string, status: string, diagnostic?: string | null, machineDir?: string, failure?: StructuredAcpError | null): SpecAuthorOperation;
export function appendSpecAuthorOperation(sessionId: string, operation: string, status: string, diagnostic?: string | null, root?: string, failure?: StructuredAcpError | null): SpecAuthorOperation;
export function appendSpecAuthorOperation(first: string, second: string, third: string, fourth?: any, fifth?: any, sixth?: any, seventh?: any): SpecAuthorOperation {
  const scoped = seventh !== undefined || (sixth !== undefined && fifth === null);
  const repositoryId = scoped ? first : undefined;
  const sessionId = scoped ? second : first;
  const operation = scoped ? third : second;
  const status = scoped ? fourth! : third;
  const diagnostic = scoped ? fifth ?? null : fourth;
  const machineDir = scoped ? (sixth as unknown as string | undefined) : fifth;
  const failure = scoped ? seventh : sixth;
  const db = scoped ? openRepositoryDb(repositoryId!, machineDir) : openDb(machineDir);
  const info = db.prepare(scoped ? "INSERT INTO spec_author_operations (repository_id, author_session_id, operation, status, diagnostic, failure) VALUES (?, ?, ?, ?, ?, ?)" : "INSERT INTO spec_author_operations (author_session_id, operation, status, diagnostic, failure) VALUES (?, ?, ?, ?, ?)").run(...(scoped ? [repositoryId, sessionId, operation, status, diagnostic, failure ? JSON.stringify(failure) : null] : [sessionId, operation, status, diagnostic, failure ? JSON.stringify(failure) : null]));
  return mapOperation(db.prepare("SELECT * FROM spec_author_operations WHERE id = ?").get(Number(info.lastInsertRowid)) as Record<string, unknown>);
}

export function listSpecAuthorOperations(repositoryId: string, sessionId: string, machineDir?: string): SpecAuthorOperation[];
export function listSpecAuthorOperations(sessionId: string, root?: string): SpecAuthorOperation[];
export function listSpecAuthorOperations(first: string, second?: string, third?: string): SpecAuthorOperation[] {
  const scoped = third !== undefined;
  const db = scoped ? openRepositoryDb(first, third) : openDb(second);
  return (db.prepare(scoped ? "SELECT * FROM spec_author_operations WHERE repository_id = ? AND author_session_id = ? ORDER BY id" : "SELECT * FROM spec_author_operations WHERE author_session_id = ? ORDER BY id").all(...(scoped ? [first, second] : [first])) as Record<string, unknown>[]).map(mapOperation);
}
