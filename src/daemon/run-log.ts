import Database from "better-sqlite3";
import { openDb } from "../db/index.js";
import type { AgentEvent } from "../agent/types.js";
import {
  publishRunEvent,
  publishRunFinished,
  publishRunStarted,
  type EventBus,
  type RunPayload,
} from "./bus.js";

export type RunStatus = "running" | "done" | "error";
export type RunRole = "builder" | "validator";

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
}

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
  if (value === "running" || value === "done" || value === "error") {
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

  constructor(root?: string, bus?: EventBus) {
    this.db = openDb(root);
    this.bus = bus;
  }

  startRun(taskId: number, role: RunRole, agentId: string, prompt: string): number {
    const info = this.db
      .prepare(
        "INSERT INTO runs (task_id, role, agent_id, status, prompt) VALUES (?, ?, ?, 'running', ?)",
      )
      .run(taskId, role, agentId, prompt);
    const runId = Number(info.lastInsertRowid);
    if (this.bus) {
      const run = this.getRun(runId);
      if (run) publishRunStarted(this.bus, toRunPayload(run));
    }
    return runId;
  }

  insertEvent(runId: number, seq: number, event: AgentEvent): void {
    this.db
      .prepare(
        "INSERT INTO run_events (run_id, seq, type, payload) VALUES (?, ?, ?, ?)",
      )
      .run(runId, seq, event.type, JSON.stringify(event));
    if (this.bus) publishRunEvent(this.bus, runId, event);
  }

  finishRun(runId: number, status: "done" | "error", opts: FinishRunOptions = {}): void {
    if (opts.commitSha !== undefined) {
      this.db
        .prepare(
          "UPDATE runs SET status = ?, commit_sha = ?, ended_at = CURRENT_TIMESTAMP WHERE id = ?",
        )
        .run(status, opts.commitSha, runId);
    } else if (opts.error !== undefined) {
      this.db
        .prepare(
          "UPDATE runs SET status = ?, error = ?, ended_at = CURRENT_TIMESTAMP WHERE id = ?",
        )
        .run(status, opts.error, runId);
    } else {
      this.db
        .prepare("UPDATE runs SET status = ?, ended_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(status, runId);
    }
    if (this.bus) {
      const run = this.getRun(runId);
      if (run) publishRunFinished(this.bus, toRunPayload(run));
    }
  }

  getRun(runId: number): RunRecord | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as
      | RunRow
      | undefined;
    return row ? rowToRun(row) : undefined;
  }

  getLastRunForTask(taskId: number): RunRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC, id DESC LIMIT 1")
      .get(taskId) as RunRow | undefined;
    return row ? rowToRun(row) : undefined;
  }

  getEvents(runId: number): RunEventRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM run_events WHERE run_id = ? ORDER BY seq")
      .all(runId) as RunEventRow[];
    return rows.map(rowToRunEvent);
  }
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
  };
}
