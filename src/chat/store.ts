import { randomUUID } from "node:crypto";
import { relative, resolve } from "node:path";
import { openDb } from "../db/index.js";
import { getSelectedRepository, repositoryRoot } from "../repositories/store.js";
import type { HistoricalAgentProvenance } from "../agents/provenance.js";
import type { StructuredAcpError } from "../acp/errors.js";
import type { AgentSessionConfigOption, AgentSessionModeState } from "../agent/types.js";

export type ChatThreadStatus = "draft" | "active" | "authentication_required" | "closed" | "error";
export type ChatMessageRole = "user" | "assistant";

export interface ChatThread {
  id: string;
  repository_id: string | null;
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
    super(`Chat thread not found: ${id}`);
    this.name = "ChatThreadNotFoundError";
  }
}

const STATUSES = new Set<ChatThreadStatus>([
  "draft",
  "active",
  "authentication_required",
  "closed",
  "error",
]);

export function isChatThreadStatus(value: string): value is ChatThreadStatus {
  return STATUSES.has(value as ChatThreadStatus);
}

function repoRoot(root?: string): string {
  const selected = root ?? repositoryRoot();
  if (!selected) throw new Error("No repository selected");
  return resolve(selected);
}

function rowToThread(row: Record<string, unknown>): ChatThread {
  let provenance: HistoricalAgentProvenance;
  try {
    provenance = JSON.parse(String(row.agent_provenance ?? "{}")) as HistoricalAgentProvenance;
  } catch {
    provenance = {
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
  return {
    ...(row as Omit<ChatThread, "archived" | "pinned" | "status">),
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
  let attachmentIds: string[] = [];
  try {
    attachmentIds = JSON.parse(String(row.attachment_ids ?? "[]")) as string[];
  } catch {
    attachmentIds = [];
  }
  return {
    ...(row as unknown as ChatMessage),
    role: row.role as ChatMessageRole,
    attachment_ids: attachmentIds,
    prompt_status:
      row.prompt_status === "authentication_required" ? "authentication_required" : null,
    failure: row.failure ? (JSON.parse(String(row.failure)) as StructuredAcpError) : null,
  };
}

export function listChatThreads(root?: string, includeArchived = false): ChatThread[] {
  const db = openDb(root);
  const repositoryId = getSelectedRepository()?.id ?? null;
  const query = includeArchived
    ? "SELECT * FROM chat_threads WHERE repo_root = ? ORDER BY pinned DESC, COALESCE(last_message_at, updated_at) DESC, created_at DESC"
    : "SELECT * FROM chat_threads WHERE repo_root = ? AND archived = 0 ORDER BY pinned DESC, COALESCE(last_message_at, updated_at) DESC, created_at DESC";
  return (db.prepare(query).all(repoRoot(root)) as Record<string, unknown>[]).map((row) =>
    rowToThread({ ...row, repository_id: row.repository_id ?? repositoryId }),
  );
}

export function getChatThread(id: string, root?: string): ChatThread {
  const db = openDb(root);
  const row = db
    .prepare("SELECT * FROM chat_threads WHERE id = ? AND repo_root = ?")
    .get(id, repoRoot(root)) as Record<string, unknown> | undefined;
  if (!row) throw new ChatThreadNotFoundError(id);
  return rowToThread({
    ...row,
    repository_id: row.repository_id ?? getSelectedRepository()?.id ?? null,
  });
}

export function createChatThread(input: CreateChatThreadInput, root?: string): ChatThread {
  const db = openDb(root);
  const id = randomUUID();
  const repository = repoRoot(root);
  const cwd = resolve(input.cwd ?? repository);
  const cwdRelative = relative(repository, cwd).replaceAll("\\", "/");
  if (cwdRelative === ".." || cwdRelative.startsWith("../") || cwdRelative.startsWith("/")) {
    throw new Error("Thread cwd must be inside the repository root");
  }
  db.prepare(
    "INSERT INTO chat_threads (id, repository_id, repo_root, cwd, agent_id, agent_version, title, task_slug, agent_provenance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    getSelectedRepository()?.id ?? null,
    repository,
    cwd,
    input.agentId,
    input.agentVersion,
    input.title?.trim() || "New thread",
    input.taskSlug ?? null,
    JSON.stringify(
      input.agentProvenance ?? {
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
      },
    ),
  );
  return getChatThread(id, root);
}

export function updateChatThread(
  id: string,
  input: UpdateChatThreadInput,
  root?: string,
): ChatThread {
  const db = openDb(root);
  const current = getChatThread(id, root);
  const updated = db
    .prepare(
      "UPDATE chat_threads SET title = ?, status = ?, archived = ?, pinned = ?, scratch_markdown = ?, failure = ?, session_config_options = ?, session_modes = ?, session_initialized = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND repo_root = ?",
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
      repoRoot(root),
    );
  if (updated.changes === 0) throw new ChatThreadNotFoundError(id);
  return getChatThread(id, root);
}

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

export function deleteChatThread(id: string, root?: string): void {
  const db = openDb(root);
  getChatThread(id, root);
  const result = db
    .prepare("DELETE FROM chat_threads WHERE id = ? AND repo_root = ?")
    .run(id, repoRoot(root));
  if (result.changes === 0) throw new ChatThreadNotFoundError(id);
}

export function listChatMessages(id: string, root?: string): ChatMessage[] {
  getChatThread(id, root);
  const db = openDb(root);
  return (
    db.prepare("SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY id ASC").all(id) as Record<
      string,
      unknown
    >[]
  ).map(rowToMessage);
}

export function appendChatMessage(
  id: string,
  role: ChatMessageRole,
  content: string,
  root?: string,
  attachmentIds: string[] = [],
): ChatMessage {
  getChatThread(id, root);
  const db = openDb(root);
  const tx = db.transaction(() => {
    const info = db
      .prepare(
        "INSERT INTO chat_messages (thread_id, role, content, attachment_ids) VALUES (?, ?, ?, ?)",
      )
      .run(id, role, content, JSON.stringify(attachmentIds));
    db.prepare(
      "UPDATE chat_threads SET status = 'active', last_message_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).run(id);
    return db
      .prepare("SELECT * FROM chat_messages WHERE id = ?")
      .get(Number(info.lastInsertRowid)) as Record<string, unknown>;
  });
  return rowToMessage(tx());
}

export function updateChatMessage(id: number, content: string, root?: string): ChatMessage {
  const db = openDb(root);
  db.prepare("UPDATE chat_messages SET content = ? WHERE id = ?").run(content, id);
  const row = db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new Error(`Chat message not found: ${id}`);
  return rowToMessage(row);
}

export function markChatMessageAuthenticationRequired(
  id: number,
  failure: StructuredAcpError,
  root?: string,
): ChatMessage {
  const db = openDb(root);
  db.prepare(
    "UPDATE chat_messages SET prompt_status = 'authentication_required', failure = ? WHERE id = ? AND role = 'user'",
  ).run(JSON.stringify(failure), id);
  const row = db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new Error(`Chat message not found: ${id}`);
  return rowToMessage(row);
}
export function clearChatMessagePromptFailure(id: number, root?: string): ChatMessage {
  const db = openDb(root);
  db.prepare(
    "UPDATE chat_messages SET prompt_status = NULL, failure = NULL WHERE id = ? AND role = 'user'",
  ).run(id);
  const row = db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new Error(`Chat message not found: ${id}`);
  return rowToMessage(row);
}
export function getChatMessage(id: number, root?: string): ChatMessage | undefined {
  const row = openDb(root).prepare("SELECT * FROM chat_messages WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToMessage(row) : undefined;
}
