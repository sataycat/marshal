import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { openDb, openRepositoryDb } from "../db/index.js";
import type { AgentEvent } from "../agent/types.js";
import type { HistoricalAgentProvenance } from "../agents/provenance.js";
import type { StructuredAcpError } from "../acp/errors.js";
import {
  publishRunEvent,
  publishRunFinished,
  publishRunStarted,
  type EventBus,
  type RunPayload,
} from "./bus.js";

export type RunStatus = "running" | "done" | "authentication_required" | "error";
export type RunRole = "builder" | "validator";

export class RunNotFoundError extends Error {
  constructor(runId: number) {
    super(`Run not found: ${runId}`);
    this.name = "RunNotFoundError";
  }
}

export interface RunRecord {
  id: number;
  taskId: number;
  role: RunRole;
  agentId: string;
  status: RunStatus;
  prompt: string | null;
  commitSha: string | null;
  startedAt: string;
  endedAt: string | null;
  error: string | null;
  agentVersion?: string;
  capabilities?: unknown;
  assignmentConfig?: unknown;
  supervisorSessionId?: string | null;
  operationId?: string | null;
  verificationStatus?: "pass" | "fail" | null;
  verificationOutput?: string | null;
  agentProvenance?: HistoricalAgentProvenance;
  failure?: StructuredAcpError | null;
  authRecoveryResolvedAt?: string | null;
  supersededByRunId?: number | null;
  repositoryId?: string;
}

export interface RunEventRecord {
  id: number;
  runId: number;
  seq: number;
  type: AgentEvent["type"];
  payload: AgentEvent;
  createdAt: string;
}

export interface FinishRunOptions {
  commitSha?: string;
  error?: string;
  failure?: StructuredAcpError;
}

export interface GetEventsOptions {
  afterSeq?: number;
  limit?: number;
}

export const DEFAULT_RUN_EVENTS_LIMIT = 100;
export const MAX_RUN_EVENTS_LIMIT = 500;

interface RunRow {
  id: number;
  task_id: number;
  role: string;
  agent_id: string;
  status: string;
  prompt: string | null;
  commit_sha: string | null;
  started_at: string;
  ended_at: string | null;
  error: string | null;
  agent_version: string;
  capabilities: string;
  assignment_config: string;
  supervisor_session_id: string | null;
  operation_id: string | null;
  verification_status: string | null;
  verification_output: string | null;
  agent_provenance: string;
  failure: string | null;
  auth_recovery_resolved_at: string | null;
  superseded_by_run_id: number | null;
  repository_id: string | null;
}

interface RunEventRow {
  id: number;
  run_id: number;
  seq: number;
  type: string;
  payload: string;
  created_at: string;
}

function asRunStatus(value: string): RunStatus {
  if (value === "running" || value === "done" || value === "authentication_required" || value === "error") {
    return value;
  }
  throw new Error(`Unknown run status: ${value}`);
}

function asRunRole(value: string): RunRole {
  if (value === "builder" || value === "validator") {
    return value;
  }
  throw new Error(`Unknown run role: ${value}`);
}

function rowToRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    role: asRunRole(row.role),
    agentId: row.agent_id,
    status: asRunStatus(row.status),
    prompt: row.prompt,
    commitSha: row.commit_sha,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    error: row.error,
    agentVersion: row.agent_version,
    capabilities: parseJson(row.capabilities, {}),
    assignmentConfig: parseJson(row.assignment_config, {}),
    supervisorSessionId: row.supervisor_session_id,
    operationId: row.operation_id,
    verificationStatus: row.verification_status === "pass" || row.verification_status === "fail" ? row.verification_status : null,
    verificationOutput: row.verification_output,
    agentProvenance: parseJson(row.agent_provenance, {}) as HistoricalAgentProvenance,
    failure: parseJson(row.failure, null) as StructuredAcpError | null,
    authRecoveryResolvedAt: row.auth_recovery_resolved_at,
    supersededByRunId: row.superseded_by_run_id,
    repositoryId: row.repository_id ?? undefined,
  };
}

function rowToRunEvent(row: RunEventRow): RunEventRecord {
  return {
    id: row.id,
    runId: row.run_id,
    seq: row.seq,
    type: row.type as AgentEvent["type"],
    payload: JSON.parse(row.payload) as AgentEvent,
    createdAt: row.created_at,
  };
}

export class RunLog {
  private db: Database.Database;
  private bus?: EventBus;

  readonly repositoryId?: string;
  constructor(repositoryIdOrRoot?: string, machineDirOrBus?: string | EventBus, maybeBus?: EventBus) {
    this.repositoryId = repositoryIdOrRoot && !repositoryIdOrRoot.includes("/") ? repositoryIdOrRoot : undefined;
    const bus = typeof machineDirOrBus === "object" ? machineDirOrBus : maybeBus;
    this.db = this.repositoryId ? openRepositoryDb(this.repositoryId, typeof machineDirOrBus === "string" ? machineDirOrBus : undefined) : openDb(repositoryIdOrRoot);
    this.bus = bus;
  }

  startRun(taskId: number, role: RunRole, agentId: string, prompt: string, provenance: { agentVersion?: string; agentProvenance?: HistoricalAgentProvenance; assignmentConfig?: unknown } = {}): number {
    const info = this.db
      .prepare(
        this.repositoryId
          ? "INSERT INTO runs (task_id, repository_id, role, agent_id, status, prompt, agent_version, agent_provenance, assignment_config, operation_id) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)"
          : "INSERT INTO runs (task_id, role, agent_id, status, prompt, agent_version, agent_provenance, assignment_config, operation_id) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)",
      )
      .run(...(this.repositoryId
        ? [taskId, this.repositoryId, role, agentId, prompt, provenance.agentVersion ?? "legacy", JSON.stringify(provenance.agentProvenance ?? {}), JSON.stringify(provenance.assignmentConfig ?? {}), randomUUID()]
        : [taskId, role, agentId, prompt, provenance.agentVersion ?? "legacy", JSON.stringify(provenance.agentProvenance ?? {}), JSON.stringify(provenance.assignmentConfig ?? {}), randomUUID()]));
    const runId = Number(info.lastInsertRowid);
    this.db.prepare("UPDATE runs SET superseded_by_run_id = ? WHERE id = (SELECT id FROM runs WHERE task_id = ? AND role = ? AND status = 'authentication_required' AND auth_recovery_resolved_at IS NOT NULL AND superseded_by_run_id IS NULL ORDER BY id DESC LIMIT 1)").run(runId, taskId, role);
    const operationId = (this.db.prepare("SELECT operation_id FROM runs WHERE id = ?").get(runId) as { operation_id: string }).operation_id;
    this.db.prepare(this.repositoryId ? "INSERT INTO run_operations (id, repository_id, run_id, operation, status) VALUES (?, ?, ?, ?, 'running')" : "INSERT INTO run_operations (id, run_id, operation, status) VALUES (?, ?, ?, 'running')").run(...(this.repositoryId ? [operationId, this.repositoryId, runId, role] : [operationId, runId, role]));
    if (this.bus) {
      const run = this.getRun(runId);
      if (run) publishRunStarted(this.bus, toRunPayload(run));
    }
    return runId;
  }

  setSupervisorEvidence(runId: number, input: { sessionId?: string | null; capabilities?: unknown }): void {
    this.db.prepare("UPDATE runs SET supervisor_session_id = COALESCE(?, supervisor_session_id), capabilities = COALESCE(?, capabilities) WHERE id = ?").run(input.sessionId ?? null, input.capabilities === undefined ? null : JSON.stringify(input.capabilities), runId);
  }

  setVerification(runId: number, status: "pass" | "fail", output: string): void {
    this.db.prepare("UPDATE runs SET verification_status = ?, verification_output = ? WHERE id = ?").run(status, output, runId);
  }

  insertEvent(runId: number, seq: number, event: AgentEvent): void {
    this.db
      .prepare(this.repositoryId ? "INSERT INTO run_events (repository_id, run_id, seq, type, payload) VALUES (?, ?, ?, ?, ?)" : "INSERT INTO run_events (run_id, seq, type, payload) VALUES (?, ?, ?, ?)")
      .run(...(this.repositoryId ? [this.repositoryId, runId, seq, event.type, JSON.stringify(event)] : [runId, seq, event.type, JSON.stringify(event)]));
    if (this.bus) publishRunEvent(this.bus, runId, event);
  }

  finishRun(runId: number, status: "done" | "error" | "authentication_required", opts: FinishRunOptions = {}): void {
    if (opts.commitSha !== undefined) {
      this.db
        .prepare(
          "UPDATE runs SET status = ?, commit_sha = ?, failure = ?, ended_at = CURRENT_TIMESTAMP WHERE id = ?",
        )
        .run(status, opts.commitSha, opts.failure ? JSON.stringify(opts.failure) : null, runId);
    } else if (opts.error !== undefined) {
      this.db
        .prepare("UPDATE runs SET status = ?, error = ?, failure = ?, ended_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(status, opts.error, opts.failure ? JSON.stringify(opts.failure) : null, runId);
    } else {
      this.db
        .prepare("UPDATE runs SET status = ?, failure = ?, ended_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(status, opts.failure ? JSON.stringify(opts.failure) : null, runId);
    }
    this.db.prepare("UPDATE run_operations SET status = ?, diagnostic = ?, ended_at = CURRENT_TIMESTAMP WHERE run_id = ? AND status = 'running'").run(status === "done" ? "succeeded" : status, opts.error ?? null, runId);
    if (this.bus) {
      const run = this.getRun(runId);
      if (run) publishRunFinished(this.bus, toRunPayload(run));
    }
  }

  getRun(runId: number): RunRecord | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | undefined;
    return row ? rowToRun(row) : undefined;
  }

  getLastRunForTask(taskId: number): RunRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC, id DESC LIMIT 1")
      .get(taskId) as RunRow | undefined;
    return row ? rowToRun(row) : undefined;
  }

  listRunsForTask(taskId: number): RunRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC, id DESC")
      .all(taskId) as RunRow[];
    return rows.map(rowToRun);
  }

  getEvents(runId: number, opts: GetEventsOptions = {}): RunEventRecord[] {
    // Default to "from the beginning". Run event seq starts at 0, so use -1
    // so that `seq > afterSeq` includes the first event.
    const afterSeq = opts.afterSeq ?? -1;
    const limit = opts.limit ?? DEFAULT_RUN_EVENTS_LIMIT;
    const rows = this.db
      .prepare("SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?")
      .all(runId, afterSeq, limit) as RunEventRow[];
    return rows.map(rowToRunEvent);
  }
  resolveAuthenticationRequired(runId: number): RunRecord { return this.db.transaction(() => { const run = this.getRun(runId); if (!run) throw new RunNotFoundError(runId); if (run.status !== "authentication_required" || run.authRecoveryResolvedAt || run.supersededByRunId) throw new Error("Authentication recovery is stale or already resolved"); const task = this.db.prepare("SELECT status FROM tasks WHERE id = ?").get(run.taskId) as { status: string } | undefined; if (!task) throw new Error("Owning task no longer exists"); const expected = run.role === "builder" ? "building" : "validating"; const dispatchable = run.role === "builder" ? "ready" : "validating"; if (task.status !== expected) throw new Error(`Owning task is ${task.status}; expected ${expected}`); this.db.prepare("UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = ?").run(dispatchable, run.taskId, expected); this.db.prepare("UPDATE runs SET auth_recovery_resolved_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'authentication_required' AND auth_recovery_resolved_at IS NULL").run(runId); return this.getRun(runId)!; })(); }
  linkSupersedingRun(runId: number, supersedingRunId: number): void { this.db.prepare("UPDATE runs SET superseded_by_run_id = ? WHERE id = ? AND status = 'authentication_required'").run(supersedingRunId, runId); }
}

function toRunPayload(run: RunRecord): RunPayload {
  return {
    id: run.id,
    taskId: run.taskId,
    role: run.role,
    agentId: run.agentId,
    status: run.status,
    prompt: run.prompt,
    commitSha: run.commitSha,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    error: run.error,
    failure: run.failure,
  };
}

function parseJson(value: string | null | undefined, fallback: unknown): unknown {
  try { return JSON.parse(value ?? ""); } catch { return fallback; }
}
