import { randomUUID } from "node:crypto";
import { openDb } from "../db/index.js";
import type { AgentPermissionRequest, PermissionOption } from "../agent/types.js";

export type PermissionRequestStatus = "pending" | "approved" | "denied" | "cancelled" | "stale" | "interrupted";
export interface PermissionRequestRecord {
  id: string; session_id: string; thread_id: string; request_id: string; tool: string; kind: string | null;
  raw_request: unknown; options: PermissionOption[]; status: PermissionRequestStatus;
  selected_option_id: string | null; decision_action: string | null; diagnostic: string | null;
  created_at: string; updated_at: string; resolved_at: string | null;
  requestId: string; sessionId: string; threadId: string; rawInput?: unknown;
}
const json = (value: unknown): string => JSON.stringify(value ?? null);
const parse = (value: unknown): unknown => { try { return JSON.parse(String(value)); } catch { return value; } };
function map(row: Record<string, unknown>): PermissionRequestRecord {
  const record = { ...(row as unknown as PermissionRequestRecord), raw_request: parse(row.raw_request), options: parse(row.options) as PermissionOption[] };
  return { ...record, requestId: record.request_id, sessionId: record.session_id, threadId: record.thread_id, rawInput: (record.raw_request as AgentPermissionRequest)?.rawInput };
}
export function createPermissionRequest(sessionId: string, threadId: string, request: AgentPermissionRequest, root?: string): PermissionRequestRecord {
  const id = randomUUID();
  openDb(root).prepare("INSERT INTO permission_requests (id, session_id, thread_id, request_id, tool, kind, raw_request, options) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, sessionId, threadId, request.requestId, request.tool, request.kind ?? null, json(request), json(request.options));
  return getPermissionRequest(id, root)!;
}
export function getPermissionRequest(id: string, root?: string): PermissionRequestRecord | undefined { const row = openDb(root).prepare("SELECT * FROM permission_requests WHERE id = ?").get(id) as Record<string, unknown> | undefined; return row ? map(row) : undefined; }
export function getPermissionRequestByRequestId(sessionId: string, requestId: string, root?: string): PermissionRequestRecord | undefined { const row = openDb(root).prepare("SELECT * FROM permission_requests WHERE session_id = ? AND request_id = ?").get(sessionId, requestId) as Record<string, unknown> | undefined; return row ? map(row) : undefined; }
export function getPermissionRequestForThread(threadId: string, requestId: string, root?: string): PermissionRequestRecord | undefined { const row = openDb(root).prepare("SELECT * FROM permission_requests WHERE thread_id = ? AND request_id = ?").get(threadId, requestId) as Record<string, unknown> | undefined; return row ? map(row) : undefined; }
export function listPermissionRequests(threadId: string, root?: string): PermissionRequestRecord[] { return (openDb(root).prepare("SELECT * FROM permission_requests WHERE thread_id = ? ORDER BY created_at").all(threadId) as Record<string, unknown>[]).map(map); }
export function resolvePermissionRequest(id: string, status: Exclude<PermissionRequestStatus, "pending">, optionId: string | null, action: string, diagnostic: string | null = null, root?: string): PermissionRequestRecord {
  const current = getPermissionRequest(id, root); if (!current) throw new Error("Permission request not found");
  if (current.status !== "pending") return current;
  openDb(root).prepare("UPDATE permission_requests SET status = ?, selected_option_id = ?, decision_action = ?, diagnostic = ?, resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'").run(status, optionId, action, diagnostic, id);
  return getPermissionRequest(id, root)!;
}
export function reconcilePermissionRequests(sessionId: string, status: "cancelled" | "interrupted", diagnostic: string, root?: string): void { openDb(root).prepare("UPDATE permission_requests SET status = ?, diagnostic = ?, resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE session_id = ? AND status = 'pending'").run(status, diagnostic, sessionId); }
export function reconcileThreadPermissions(threadId: string, root?: string): void { openDb(root).prepare("UPDATE permission_requests SET status = 'cancelled', diagnostic = 'Thread was deleted', resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE thread_id = ? AND status = 'pending'").run(threadId); }
