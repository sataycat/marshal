import { randomUUID } from "node:crypto";
import { openRepositoryDb } from "../db/index.js";
import { getSession } from "./supervisor-store.js";
import type { AgentPermissionRequest, PermissionOption } from "../agent/types.js";

export type PermissionRequestStatus = "pending" | "approved" | "denied" | "cancelled" | "stale" | "interrupted";
export interface PermissionRequestRecord {
  id: string; repository_id: string; session_id: string; thread_id: string; request_id: string; tool: string; kind: string | null;
  raw_request: unknown; options: PermissionOption[]; status: PermissionRequestStatus;
  selected_option_id: string | null; decision_action: string | null; diagnostic: string | null;
  created_at: string; updated_at: string; resolved_at: string | null;
  requestId: string; sessionId: string; threadId: string; rawInput?: unknown;
}
const json = (value: unknown): string => JSON.stringify(value ?? null);
const parse = (value: unknown): unknown => { try { return JSON.parse(String(value)); } catch { return value; } };
function map(row: Record<string, unknown>): PermissionRequestRecord {
  const record = { ...(row as unknown as PermissionRequestRecord), repository_id: String(row.repository_id), raw_request: parse(row.raw_request), options: parse(row.options) as PermissionOption[] };
  return { ...record, requestId: record.request_id, sessionId: record.session_id, threadId: record.thread_id, rawInput: (record.raw_request as AgentPermissionRequest)?.rawInput };
}
export function createPermissionRequest(repositoryId: string, sessionId: string, threadId: string, request: AgentPermissionRequest, machineDir?: string): PermissionRequestRecord {
  if (!getSession(repositoryId, sessionId, machineDir)) throw new Error(`ACP session not found: ${sessionId}`);
  const id = randomUUID();
  openRepositoryDb(repositoryId, machineDir).prepare("INSERT INTO permission_requests (id, repository_id, session_id, thread_id, request_id, tool, kind, raw_request, options) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, repositoryId, sessionId, threadId, request.requestId, request.tool, request.kind ?? null, json(request), json(request.options));
  return getPermissionRequest(repositoryId, id, machineDir)!;
}
export function getPermissionRequest(repositoryId: string, id: string, machineDir?: string): PermissionRequestRecord | undefined { const row = openRepositoryDb(repositoryId, machineDir).prepare("SELECT * FROM permission_requests WHERE id = ? AND repository_id = ?").get(id, repositoryId) as Record<string, unknown> | undefined; return row ? map(row) : undefined; }
export function getPermissionRequestByRequestId(repositoryId: string, sessionId: string, requestId: string, machineDir?: string): PermissionRequestRecord | undefined { const row = openRepositoryDb(repositoryId, machineDir).prepare("SELECT * FROM permission_requests WHERE repository_id = ? AND session_id = ? AND request_id = ?").get(repositoryId, sessionId, requestId) as Record<string, unknown> | undefined; return row ? map(row) : undefined; }
export function getPermissionRequestForThread(repositoryId: string, threadId: string, requestId: string, machineDir?: string): PermissionRequestRecord | undefined { const row = openRepositoryDb(repositoryId, machineDir).prepare("SELECT * FROM permission_requests WHERE repository_id = ? AND thread_id = ? AND request_id = ?").get(repositoryId, threadId, requestId) as Record<string, unknown> | undefined; return row ? map(row) : undefined; }
export function listPermissionRequests(repositoryId: string, threadId: string, machineDir?: string): PermissionRequestRecord[] { return (openRepositoryDb(repositoryId, machineDir).prepare("SELECT * FROM permission_requests WHERE repository_id = ? AND thread_id = ? ORDER BY created_at").all(repositoryId, threadId) as Record<string, unknown>[]).map(map); }
export function resolvePermissionRequest(repositoryId: string, id: string, status: Exclude<PermissionRequestStatus, "pending">, optionId: string | null, action: string, diagnostic: string | null = null, machineDir?: string): PermissionRequestRecord {
  const current = getPermissionRequest(repositoryId, id, machineDir); if (!current) throw new Error("Permission request not found");
  if (current.status !== "pending") return current;
  openRepositoryDb(repositoryId, machineDir).prepare("UPDATE permission_requests SET status = ?, selected_option_id = ?, decision_action = ?, diagnostic = ?, resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND repository_id = ? AND status = 'pending'").run(status, optionId, action, diagnostic, id, repositoryId);
  return getPermissionRequest(repositoryId, id, machineDir)!;
}
export function reconcilePermissionRequests(repositoryId: string, sessionId: string, status: "cancelled" | "interrupted", diagnostic: string, machineDir?: string): void { openRepositoryDb(repositoryId, machineDir).prepare("UPDATE permission_requests SET status = ?, diagnostic = ?, resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE repository_id = ? AND session_id = ? AND status = 'pending'").run(status, diagnostic, repositoryId, sessionId); }
export function reconcileThreadPermissions(repositoryId: string, threadId: string, machineDir?: string): void { openRepositoryDb(repositoryId, machineDir).prepare("UPDATE permission_requests SET status = 'cancelled', diagnostic = 'Thread was deleted', resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE repository_id = ? AND thread_id = ? AND status = 'pending'").run(repositoryId, threadId); }
