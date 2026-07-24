import { randomUUID } from "node:crypto";
import { relative, resolve } from "node:path";
import { openRepositoryDb } from "../db/index.js";
import { resolveRepositoryContext } from "../repositories/context.js";
import { removeAttachmentTree } from "./attachment-storage.js";
import type { HistoricalAgentProvenance } from "../agents/provenance.js";
import type { StructuredAcpError } from "../acp/errors.js";
import type { AgentSessionConfigOption, AgentSessionModeState } from "../agent/types.js";

export type ChatThreadStatus = "active" | "authentication_required" | "closed" | "error";
export type ChatMessageRole = "user" | "assistant";

export interface ChatThread {
  id: string;
  repository_id: string;
  repo_root: string;
  cwd: string;
  agent_id: string;
  agent_version: string;
  title: string;
  status: ChatThreadStatus;
  archived: boolean;
  pinned: boolean;
  task_slug: string | null;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
  scratch_markdown: string;
  agent_provenance: HistoricalAgentProvenance;
  session_config_options: AgentSessionConfigOption[];
  session_modes: AgentSessionModeState | null;
  session_initialized: boolean;
  failure: StructuredAcpError | null;
}

export interface ChatMessage {
  id: number;
  repository_id: string;
  thread_id: string;
  role: ChatMessageRole;
  content: string;
  created_at: string;
  attachment_ids: string[];
  prompt_status: "authentication_required" | null;
  failure: StructuredAcpError | null;
}

export interface CreateChatThreadInput {
  agentId: string;
  agentVersion: string;
  cwd?: string;
  title?: string;
  taskSlug?: string;
  agentProvenance?: HistoricalAgentProvenance;
}

export interface UpdateChatThreadInput {
  title?: string;
  status?: ChatThreadStatus;
  archived?: boolean;
  pinned?: boolean;
  scratchMarkdown?: string;
  failure?: StructuredAcpError | null;
  sessionConfigOptions?: AgentSessionConfigOption[];
  sessionModes?: AgentSessionModeState | null;
  sessionInitialized?: boolean;
}

export class ChatThreadNotFoundError extends Error {
  constructor(id: string) {
    super(`Chat session not found: ${id}`);
    this.name = "ChatThreadNotFoundError";
  }
}

const STATUSES = new Set<ChatThreadStatus>([
  "active",
  "authentication_required",
  "closed",
  "error",
]);

export function isChatThreadStatus(value: string): value is ChatThreadStatus {
  return STATUSES.has(value as ChatThreadStatus);
}

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

function legacyProvenance(row: Record<string, unknown>): HistoricalAgentProvenance {
  return {
    installation_id: null,
    agent_id: String(row.agent_id),
    agent_version: String(row.agent_version),
    distribution: null,
    package_specifier: null,
    archive_identity: null,
    source: "legacy",
    registry_snapshot_fetched_at: null,
    integrity_status: "legacy",
    expected_digest: null,
    observed_digest: null,
  };
}

function rowToThread(row: Record<string, unknown>): ChatThread {
  let provenance: HistoricalAgentProvenance;
  try {
    provenance = JSON.parse(String(row.agent_provenance ?? "{}")) as HistoricalAgentProvenance;
  } catch {
    provenance = legacyProvenance(row);
  }
  return {
    ...(row as Omit<ChatThread, "archived" | "pinned" | "status">),
    repository_id: String(row.repository_id),
    status: row.status as ChatThreadStatus,
    archived: row.archived === 1,
    pinned: row.pinned === 1,
    agent_provenance: provenance,
    session_config_options: parseJson(row.session_config_options, []),
    session_modes: row.session_modes ? parseJson(row.session_modes, null) : null,
    session_initialized: row.session_initialized === 1,
    failure: row.failure ? (JSON.parse(String(row.failure)) as StructuredAcpError) : null,
  };
}

function rowToMessage(row: Record<string, unknown>): ChatMessage {
  return {
    ...(row as unknown as ChatMessage),
    repository_id: String(row.repository_id),
    role: row.role as ChatMessageRole,
    attachment_ids: parseJson(row.attachment_ids, []),
    prompt_status:
      row.prompt_status === "authentication_required" ? "authentication_required" : null,
    failure: row.failure ? (JSON.parse(String(row.failure)) as StructuredAcpError) : null,
  };
}

export function listChatThreads(
  repositoryId: string,
  includeArchived = false,
  machineDir?: string,
): ChatThread[] {
  const db = openRepositoryDb(repositoryId, machineDir);
  const archived = includeArchived ? "" : " AND archived = 0";
  return (
    db
      .prepare(
        `SELECT * FROM chat_threads WHERE repository_id = ?${archived} ORDER BY pinned DESC, COALESCE(last_message_at, updated_at) DESC, created_at DESC`,
      )
      .all(repositoryId) as Record<string, unknown>[]
  ).map(rowToThread);
}

export function getChatThread(
  repositoryId: string,
  id: string,
  machineDir?: string,
): ChatThread {
  const row = openRepositoryDb(repositoryId, machineDir)
    .prepare("SELECT * FROM chat_threads WHERE id = ? AND repository_id = ?")
    .get(id, repositoryId) as Record<string, unknown> | undefined;
  if (!row) throw new ChatThreadNotFoundError(id);
  return rowToThread(row);
}

export function createChatThread(
  repositoryId: string,
  input: CreateChatThreadInput,
  machineDir?: string,
): ChatThread {
  const context = resolveRepositoryContext(repositoryId, machineDir);
  const db = openRepositoryDb(repositoryId, machineDir);
  const id = randomUUID();
  const repository = context.checkoutPath;
  const cwd = resolve(input.cwd ?? repository);
  const cwdRelative = relative(repository, cwd).replaceAll("\\", "/");
  if (cwdRelative === ".." || cwdRelative.startsWith("../") || cwdRelative.startsWith("/")) {
    throw new Error("Session cwd must be inside the repository root");
  }
  db.prepare(
    "INSERT INTO chat_threads (id, repository_id, repo_root, cwd, agent_id, agent_version, title, status, task_slug, agent_provenance) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)",
  ).run(
    id,
    repositoryId,
    repository,
    cwd,
    input.agentId,
    input.agentVersion,
    input.title?.trim() || "New session",
    input.taskSlug ?? null,
    JSON.stringify(input.agentProvenance ?? {
      installation_id: null,
      agent_id: input.agentId,
      agent_version: input.agentVersion,
      distribution: null,
      package_specifier: null,
      archive_identity: null,
      source: "legacy",
      registry_snapshot_fetched_at: null,
      integrity_status: "legacy",
      expected_digest: null,
      observed_digest: null,
    }),
  );
  return getChatThread(repositoryId, id, machineDir);
}

export function updateChatThread(
  repositoryId: string,
  id: string,
  input: UpdateChatThreadInput,
  machineDir?: string,
): ChatThread {
  const db = openRepositoryDb(repositoryId, machineDir);
  const current = getChatThread(repositoryId, id, machineDir);
  const updated = db
    .prepare(
      "UPDATE chat_threads SET title = ?, status = ?, archived = ?, pinned = ?, scratch_markdown = ?, failure = ?, session_config_options = ?, session_modes = ?, session_initialized = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND repository_id = ?",
    )
    .run(
      input.title?.trim() || current.title,
      input.status ?? current.status,
      input.archived === undefined ? Number(current.archived) : Number(input.archived),
      input.pinned === undefined ? Number(current.pinned) : Number(input.pinned),
      input.scratchMarkdown ?? current.scratch_markdown,
      input.failure === undefined
        ? current.failure
          ? JSON.stringify(current.failure)
          : null
        : input.failure
          ? JSON.stringify(input.failure)
          : null,
      JSON.stringify(input.sessionConfigOptions ?? current.session_config_options),
      input.sessionModes === undefined
        ? current.session_modes
          ? JSON.stringify(current.session_modes)
          : null
        : input.sessionModes
          ? JSON.stringify(input.sessionModes)
          : null,
      input.sessionInitialized === undefined
        ? Number(current.session_initialized)
        : Number(input.sessionInitialized),
      id,
      repositoryId,
    );
  if (updated.changes === 0) throw new ChatThreadNotFoundError(id);
  return getChatThread(repositoryId, id, machineDir);
}

export function deleteChatThread(repositoryId: string, id: string, machineDir?: string): void {
  const db = openRepositoryDb(repositoryId, machineDir);
  getChatThread(repositoryId, id, machineDir);
  const attachments = db
    .prepare("SELECT storage_key FROM chat_attachments WHERE repository_id = ? AND thread_id = ? ORDER BY id")
    .all(repositoryId, id) as Array<{ storage_key: string }>;
  removeAttachmentTree(repositoryId, id, attachments.map((row) => row.storage_key), machineDir);
  const result = db
    .prepare("DELETE FROM chat_threads WHERE id = ? AND repository_id = ?")
    .run(id, repositoryId);
  if (result.changes === 0) throw new ChatThreadNotFoundError(id);
}

export function listChatMessages(
  repositoryId: string,
  threadId: string,
  machineDir?: string,
): ChatMessage[] {
  // Resolve the owning thread first so a request made with another
  // repository ID is a missing resource, not an empty successful query.
  getChatThread(repositoryId, threadId, machineDir);
  return (
    openRepositoryDb(repositoryId, machineDir)
      .prepare(
        "SELECT * FROM chat_messages WHERE repository_id = ? AND thread_id = ? ORDER BY id ASC",
      )
      .all(repositoryId, threadId) as Record<string, unknown>[]
  ).map(rowToMessage);
}

export function appendChatMessage(
  repositoryId: string,
  threadId: string,
  role: ChatMessageRole,
  content: string,
  attachmentIds: string[] = [],
  machineDir?: string,
): ChatMessage {
  getChatThread(repositoryId, threadId, machineDir);
  const db = openRepositoryDb(repositoryId, machineDir);
  const tx = db.transaction(() => {
    const info = db
      .prepare(
        "INSERT INTO chat_messages (repository_id, thread_id, role, content, attachment_ids) VALUES (?, ?, ?, ?, ?)",
      )
      .run(repositoryId, threadId, role, content, JSON.stringify(attachmentIds));
    db.prepare(
      "UPDATE chat_threads SET status = 'active', last_message_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND repository_id = ?",
    ).run(threadId, repositoryId);
    return db
      .prepare("SELECT * FROM chat_messages WHERE id = ? AND repository_id = ?")
      .get(Number(info.lastInsertRowid), repositoryId) as Record<string, unknown>;
  });
  return rowToMessage(tx());
}

export function updateChatMessage(
  repositoryId: string,
  id: number,
  content: string,
  machineDir?: string,
): ChatMessage {
  const db = openRepositoryDb(repositoryId, machineDir);
  db.prepare("UPDATE chat_messages SET content = ? WHERE id = ? AND repository_id = ?").run(
    content,
    id,
    repositoryId,
  );
  const row = db
    .prepare("SELECT * FROM chat_messages WHERE id = ? AND repository_id = ?")
    .get(id, repositoryId) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`Chat message not found: ${id}`);
  return rowToMessage(row);
}

export function markChatMessageAuthenticationRequired(
  repositoryId: string,
  id: number,
  failure: StructuredAcpError,
  machineDir?: string,
): ChatMessage {
  const db = openRepositoryDb(repositoryId, machineDir);
  db.prepare(
    "UPDATE chat_messages SET prompt_status = 'authentication_required', failure = ? WHERE id = ? AND repository_id = ? AND role = 'user'",
  ).run(JSON.stringify(failure), id, repositoryId);
  const row = db
    .prepare("SELECT * FROM chat_messages WHERE id = ? AND repository_id = ?")
    .get(id, repositoryId) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`Chat message not found: ${id}`);
  return rowToMessage(row);
}

export function clearChatMessagePromptFailure(
  repositoryId: string,
  id: number,
  machineDir?: string,
): ChatMessage {
  const db = openRepositoryDb(repositoryId, machineDir);
  db.prepare(
    "UPDATE chat_messages SET prompt_status = NULL, failure = NULL WHERE id = ? AND repository_id = ? AND role = 'user'",
  ).run(id, repositoryId);
  const row = db
    .prepare("SELECT * FROM chat_messages WHERE id = ? AND repository_id = ?")
    .get(id, repositoryId) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`Chat message not found: ${id}`);
  return rowToMessage(row);
}

export function getChatMessage(
  repositoryId: string,
  id: number,
  machineDir?: string,
): ChatMessage | undefined {
  const row = openRepositoryDb(repositoryId, machineDir)
    .prepare("SELECT * FROM chat_messages WHERE id = ? AND repository_id = ?")
    .get(id, repositoryId) as Record<string, unknown> | undefined;
  return row ? rowToMessage(row) : undefined;
}
