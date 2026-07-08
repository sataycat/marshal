# ADR-006: Builder Run and Run Log

## Status

Accepted — 2026-07-08

Implements `docs/M0-VERTICAL-SLICES.md` Slice 5 (Builder Run — End-to-End). Settles open ADR questions #2 (agent prompt templates — builder side) and #3 (run log schema) from `docs/M0-VERTICAL-SLICES.md:175`.

## Context

Slices 1–4 and 8 are complete. The pieces in place:

- **State machine** (Slice 3): `ready → building → validating` transitions enforced in `src/tasks/state-machine.ts:3`.
- **Worktree** (Slice 2, amended by ADR-004): `WorktreeManager.create(slug)` creates or returns the task worktree at `~/.marshal/worktrees/<repo-hash>/<slug>-<descriptor>/`.
- **Spec freeze** (Slice 8, ADR-005): the freeze at Ready creates the worktree and commits `specs/<NNNN>-<slug>.md` to the task branch. The builder worktree already exists when the orchestrator picks up the task — "the orchestrator reuses the existing worktree via `WorktreeManager.create(slug)`, which already short-circuits to the existing record" (ADR-005, Consequences).
- **Agent adapter** (Slice 4, ADR-003): `Agent.spawn/prompt/cancel/close` with `AcpxAgentAdapter` shelling out to `acpx`. Events stream from `prompt` as `AsyncIterable<AgentEvent>` (ADR-003 Decision 1).

Slice 5 ties these together: the orchestrator claims a `ready` task, runs opencode in the frozen worktree against the spec, commits the result, and moves the task to `validating`. The run log goes to SQLite.

Three open ADR questions from `docs/M0-VERTICAL-SLICES.md:175` land here:

- **#2 — Agent prompt templates (builder side).** ADR-005 explicitly defers: "The builder's prompt (Slice 5) will compose from the frozen file in the worktree plus any orchestrator context; the exact template is Slice 5's ADR territory." This ADR settles the builder template but **deviates from ADR-005's "compose from the frozen file"** — the spec is inlined from SQLite `spec_markdown` instead (Decision 3). The validator half of #2 stays deferred to Slice 6.
- **#3 — Run log schema.** ADR-003 explicitly defers: "Persisting events to SQLite (the run log) is Slice 5's job and may warrant its own ADR."
- **#4 — Configuration (builder defaults).** Partially settled here (builder agent and timeout defaults); the broader config-location question stays deferred.

## Decisions

### 1. Two functions: `runOnce()` claims and dispatches; `buildTask(slug)` executes one build

```ts
// src/daemon/orchestrator.ts

export interface RunOnceResult {
  slug: string;
  runId: number;
  commitSha: string;
  status: "built" | "error" | "skipped";
  error?: string;
}

export async function runOnce(
  root?: string,
  agent?: Agent,
  manager?: WorktreeManager,
): Promise<RunOnceResult | null>;
```

- **`runOnce()`** — one iteration of the orchestration loop. Finds the next `ready` task, runs pre-flight checks, claims it (`ready → building`), calls `buildTask`, and routes the result. Returns `null` when no `ready` task exists. This is the function `marshal daemon run-once` (Slice 9) will call.
- **`buildTask(slug)`** — executes one builder run for a task already in `building`. Spawns the agent, streams events into the run log, commits, and returns the build result. Does not handle claim or state transitions; `runOnce` does those.

Separation rationale: `runOnce` owns the state-machine moves (claim, advance to validating, leave on error); `buildTask` owns the agent interaction and git commit. This keeps the agent-testable core (`buildTask`) decoupled from the task-selection policy, and lets Slice 7's retry routing call `buildTask` again on a bounce-back without re-claiming.

### 2. Claim = `ready → building` transition; pre-flight checks run before claiming

`runOnce` does, in order:

1. **Select**: `SELECT * FROM tasks WHERE status = 'ready' ORDER BY created_at ASC, id ASC LIMIT 1` — FIFO by creation time.
2. **Pre-flight**: look up the worktree via `WorktreeManager.create(slug)` (returns the existing record from the freeze), and verify the frozen spec file exists at `specs/<NNNN>-<slug>.md` inside it. ADR-005 Decision 5 says "run-once will refuse to build from a task that has no frozen spec" — this is the enforcement point.
3. **Claim**: `transitionTask(slug, "building")`. The SQLite transaction in `transitionTask` (`src/tasks/store.ts:87-104`) is the claim. Under concurrency 1 (PROJECT.md §6) there is no race; if concurrency rises later, the transaction is already the serialization point.
4. **Build**: `await buildTask(slug, root, agent, manager)`.
5. **Route**: on `built`, `transitionTask(slug, "validating")`. On `error`, leave the task in `building` and log (see Decision 7).

If pre-flight fails (worktree missing, spec file missing), `runOnce` returns `{ status: "skipped", error }` **without claiming** — the task stays in `ready`. The error is emitted via the structured logger (pino). No run record is created because no build started; the pre-flight failure is a configuration/env issue, not a build attempt. The task remains pick-up-able once the human fixes it (re-freeze with `marshal task freeze <slug>`).

### 3. Builder prompt: inline the spec from SQLite `spec_markdown`

The spec body is inlined directly into the prompt. The agent receives the full spec in its first turn — no tool call to read a file, no round-trip overhead. This **deviates from** PROJECT.md §7 ("the builder reads it via git in its worktree") and ADR-005 ("the builder reads the spec from that file, not from SQLite"). The deviation is deliberate: inlining saves the tool-call tokens (the agent's decision to read, the read tool-call envelope, the result processing) on top of the content tokens, which are spent either way.

The spec source is `task.spec_markdown` from SQLite — the `Task` object is already loaded by `runOnce` in Decision 2, so there is zero extra I/O. The frozen spec file (`specs/<NNNN>-<slug>.md`) still exists in the worktree for auditability and for the validator (Slice 6); inlining into the prompt does not remove it. In M0 the SQLite body and the frozen file body are identical because `spec_markdown` is write-once at `createTask` time (`src/tasks/store.ts:72-74`, no `task update` command exists yet). When spec revision lands (unfreeze/revise/re-freeze per ADR-005 open questions), a future ADR will need to decide whether to inline from SQLite or from the frozen file — at that point they could diverge. For M0, SQLite is simpler and equivalent.

Default template (rendered by `renderBuilderPrompt(task)`):

```
You are working on task "{title}" (slug: {slug}).

## Spec

{spec_markdown}

## Instructions

Follow repo conventions (see AGENTS.md if present). Write tests for new code. Run type-checks and tests before finishing.

Do not commit — your changes will be committed automatically when you finish.
```

Design notes:

- **`{spec_markdown}`** is `task.spec_markdown` verbatim — no front-matter, no transformation. The frozen file's YAML front-matter (slug, title, task_id, frozen_at from ADR-005 Decision 3) is metadata for git audit, not for the agent; inlining from SQLite skips it naturally.
- **`{title}`** and **`{slug}`** are the task's title and slug from SQLite. Minimal orchestrator context — enough for the agent to identify the task.
- **No spec file path in the prompt.** Mentioning `specs/<NNNN>-<slug>.md` would tempt the agent to waste a tool call re-reading it. The agent has the content inline; the file exists for the validator and the audit trail, not for the builder to discover.
- **"Do not commit"** is advisory. opencode with `--approve-all` can run git commands and may commit as part of its workflow. The orchestrator handles this gracefully (Decision 5: `git add -A` + `--allow-empty` captures any remaining uncommitted changes, and agent-made commits are simply part of the branch history). The instruction reduces double-commits but is not load-bearing.
- **In-loop gate is a prompt instruction, not orchestrator-managed.** "Run type-checks and tests before finishing" tells the builder to self-iterate on fast gates (PROJECT.md §6). The orchestrator does not verify in-loop gate results — that is the builder's own workflow. The real gate is the boundary validator (Slice 6). See Decision 8.
- **Prompt size and the `runs.prompt` column.** Inlining makes the rendered prompt larger (it includes the full spec). The `runs.prompt` column (Decision 6) stores the exact prompt for auditability. This is redundant with `spec_markdown` in SQLite and the frozen file, but the audit value of "exactly what the agent was told" outweighs the storage cost for M0. If specs grow large, a later ADR can store a reference instead of the full text.
- **Template override is deferred.** The template is a function in `src/daemon/orchestrator.ts`, not config-driven in M0. When the org needs per-repo or per-task prompt customization (e.g. extra context, different agent conventions), that becomes a `marshal.json` → `builder.promptTemplate` field in a later ADR. M0 has one builder (opencode) and one template.

### 4. Builder session: opencode, cwd-scoped to the worktree, named `marshal-<slug>-builder`, closed after the run

Per ADR-003 Decision 3, the session scope key is `(agentCommand, cwd=<worktree>, name=<role>)`.

- **Agent**: `"opencode"` (hardcoded for M0; the `AGENT_TOKENS` map in `src/agent/acpx-adapter.ts:14` makes adding agents a one-line change).
- **Session name**: `marshal-<slug>-builder` — the ADR-003 pattern `marshal-<slug>-<role>` with role `builder`. This distinguishes builder sessions from validator sessions (Slice 6 will use `marshal-<slug>-validator`) even though they share the same worktree cwd initially.
- **Permission mode**: `--approve-all --non-interactive-permissions fail` (ADR-003 Decision 4, the M0 default for headless runs).
- **Timeout**: 1800s default (ADR-003 default, `src/agent/acpx-adapter.ts:20`). Configurable via `SpawnOptions.timeoutSeconds` when there's a reason.
- **Lifecycle**: `spawn` (ensure) → `prompt` (stream) → `close` (soft-close). The orchestrator calls `close` in a `finally` block so the session is closed even on error. Session records persist under `~/.acpx/sessions/` until pruned (ADR-003 deferred pruning to a later slice).

The `Agent` instance is injectable into both `runOnce` and `buildTask` for testing. Production code constructs `new AcpxAgentAdapter()`; tests inject a fake `Agent` that yields canned `AgentEvent`s without shelling out.

### 5. Builder commit: `git add -A && git commit --allow-empty -m "build: <slug>"` — always

After the builder stream ends (done or error-but-committing), the orchestrator seals the build:

1. `git add -A` in the worktree — stage all changes (new, modified, deleted) that are not gitignored.
2. `git commit --allow-empty -m "build: <slug>"` — always commit, even if the tree is unchanged.

The `--allow-empty` is deliberate:

- If the builder committed internally (despite the prompt saying not to), `git add -A` stages nothing and the `build:` commit is an empty marker on top. The validator (Slice 6) diffs `origin/<trunk>...HEAD` and sees all changes regardless of commit boundaries.
- If the builder made no changes (edge case: spec already satisfied, or builder did nothing), the empty commit marks the build attempt in `git log` and gives the validator a clear "build HEAD" to diff.
- The commit message `build: <slug>` mirrors the `freeze: <slug>` convention from ADR-005 Decision 4. No body, no trailers, no footers in M0.

The resulting `git rev-parse HEAD` is stored as `runs.commit_sha` (Decision 6) for audit and query. The validator (Slice 6) creates a second worktree from the same branch tip, so it sees the same HEAD; `commit_sha` is for the run log, not strictly for the validator.

If the commit fails (git error, disk full), the run is recorded as `error` and the task stays in `building` (Decision 7).

### 6. Run log schema: `runs` + `run_events` tables in SQLite

Two new tables in `src/db/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  role TEXT NOT NULL,           -- 'builder' | 'validator'
  agent_id TEXT NOT NULL,       -- 'opencode' | 'pi'
  status TEXT NOT NULL DEFAULT 'running',  -- 'running' | 'done' | 'error'
  prompt TEXT,                  -- the rendered prompt sent to the agent
  commit_sha TEXT,              -- build commit SHA (builder only; null while running)
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at DATETIME,            -- null while running
  error TEXT,                   -- error message when status = 'error'
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE INDEX IF NOT EXISTS idx_runs_task_id ON runs(task_id);

CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,         -- 0-indexed position within the run
  type TEXT NOT NULL,           -- AgentEvent.type: 'text'|'thinking'|'tool'|'permission'|'log'|'done'|'error'
  payload TEXT NOT NULL,        -- JSON-encoded AgentEvent
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE INDEX IF NOT EXISTS idx_run_events_run_id ON run_events(run_id, seq);
```

Design notes:

- **One `runs` row per build attempt.** A task that bounces back from validation (Slice 7) gets a second `runs` row with the same `task_id` and `role = 'builder'`. This is the audit trail of every attempt.
- **One `run_events` row per `AgentEvent`.** Events are inserted as they arrive from the `prompt` async iterable — streaming, not buffered. `seq` preserves order. `payload` is `JSON.stringify(event)` so the full typed event is recoverable.
- **`role` column** is `'builder'` now and `'validator'` in Slice 6. One schema for both run types; no separate validator log table.
- **`prompt` column** stores the rendered prompt text for debugging and for Slice 7's bounce-back (which appends failure context to the previous prompt).
- **`status` lifecycle**: `running` → `done` (stream ended with a `done` event, commit succeeded) or `error` (stream ended with an `error` event, or commit failed). `ended_at` is set on both terminal states.
- **Query patterns**: "last build run for task X" → `SELECT * FROM runs WHERE task_id = ? AND role = 'builder' ORDER BY started_at DESC LIMIT 1`. "Events for run Y" → `SELECT * FROM run_events WHERE run_id = ? ORDER BY seq`. "All errors" → `SELECT * FROM run_events WHERE type = 'error'`.
- **`better-sqlite3` is synchronous**, so event inserts are sync calls inside the `for await` loop over the async iterable. This is fine — the agent stream is the slow part, and sync inserts on each event are cheap.

A `RunLog` helper (`src/daemon/run-log.ts`) wraps these inserts:

```ts
export interface RunLog {
  startRun(taskId: number, role: string, agentId: string, prompt: string): number;  // returns runId
  insertEvent(runId: number, seq: number, event: AgentEvent): void;
  finishRun(runId: number, status: "done" | "error", opts?: { commitSha?: string; error?: string }): void;
  getRun(runId: number): RunRecord | undefined;
  getEvents(runId: number): RunEventRecord[];
}
```

### 7. Builder failure: leave task in `building`, record run as `error`; no retry in Slice 5

Failure modes and handling:

| Failure | Detection | Task state | Run status | Action |
|---|---|---|---|---|
| Agent stream ends with `{type:"error"}` | `AgentEvent.type === "error"` | stays `building` | `error` | Log error message; do not commit; do not transition |
| Agent timeout (ACPX exit 3) | `{type:"done", stopReason:"timeout"}` then `{type:"error", code:3}` | stays `building` | `error` | Same as above |
| Agent `spawn` throws (acpx missing, auth fail) | `spawn` rejection | stays `building` | `error` | Record error with no events |
| Builder commit fails (git error) | `execFileSync` throws | stays `building` | `error` | Record error; partial changes may be in worktree |
| Process crash mid-build | run row stays `running` | stays `building` | `running` (stale) | Not auto-recovered in M0; human intervenes |

On any failure, `runOnce` returns `{ status: "error", error }`. The task is observably stuck in `building` — `marshal task show <slug>` displays the status, and the run log has the error. No automatic retry, no state rollback. This is the M0 "start HITL-heavy" posture (PROJECT.md §5, tenet 5).

**Retry routing is Slice 7.** Slice 7 will add: retry count tracking, `validating → building` bounce-back with failure context, and cap-based escalation to `review`. Slice 5 delivers the run log that Slice 7 needs to reference.

The `close(session)` call is in a `finally` block so the ACPX session is soft-closed even on error, avoiding leaked session records.

### 8. In-loop gate is the builder's own workflow, not orchestrator-managed

PROJECT.md §6 defines two gate levels:

- **In-loop** (fast, cheap, deterministic): typecheck, lint, unit tests — "runs inside the builder's iteration."
- **Boundary** (comprehensive): integration/scenario tests run by the decorrelated validator (Slice 6).

For M0 Slice 5, the in-loop gate is entirely the builder's responsibility. The orchestrator's prompt says "Run type-checks and tests before finishing" — this is an instruction, not an enforcement. The orchestrator does not:

- Parse builder tool-call output for test results.
- Verify that typecheck/lint/tests passed before transitioning to `validating`.
- Re-run any checks itself.

The builder (opencode) self-plans and self-iterates via its own todo tooling (PROJECT.md §5.1: "planning is internal to the build run, not a HITL checkpoint"). Whether it actually runs the checks is the builder's problem. If it skips them, the boundary validator (Slice 6) catches the resulting test failures.

This keeps Slice 5 narrow: run the builder to completion, commit, hand off. The gate enforcement starts in Slice 6.

### 9. CLI commands (`daemon run-once`, `daemon start`) are Slice 9; Slice 5 delivers the functions

Slice 5 delivers `runOnce()` and `buildTask()` as importable functions in `src/daemon/orchestrator.ts`. The CLI commands that drive them are Slice 9's scope:

- `marshal daemon run-once` → calls `runOnce()` once, prints the result, exits.
- `marshal daemon start` → polls: calls `runOnce()` in a loop with a sleep interval, runs until interrupted.

Slice 5's acceptance test is a script or test that calls `runOnce()` directly (with a fake `Agent`), not a CLI command. The integration test with a real repo and stub agent is Slice 9.

### 10. File layout

| File | Responsibility |
|---|---|
| `src/daemon/orchestrator.ts` | `runOnce()`, `buildTask()`, `renderBuilderPrompt()` |
| `src/daemon/run-log.ts` | `RunLog` helper: `startRun`, `insertEvent`, `finishRun`, `getRun`, `getEvents` |
| `src/daemon/orchestrator.test.ts` | Unit tests with a fake `Agent` and temp git repo |
| `src/daemon/run-log.test.ts` | Unit tests for the run log CRUD |
| `src/db/schema.sql` | Add `runs` and `run_events` tables + indexes |

No new CLI commands in Slice 5 (Decision 9). No changes to `src/cli.ts`.

## Consequences

- **New DB tables**: `runs` and `run_events`. `openDb()` already runs `schema.sql` on every open (`src/db/index.ts:20-21`), so the tables are created automatically — no migration step.
- **`runOnce` is async** because `agent.prompt` returns an `AsyncIterable`. The CLI (Slice 9) already uses `await program.parseAsync()` (`src/cli.ts:54`), so async commands are supported.
- **The builder worktree is reused, not created.** ADR-005 already settled this: `WorktreeManager.create(slug)` returns the existing record. `runOnce` calls it in pre-flight to get the path; no new worktree is created at Building.
- **One ACPX session per build attempt.** `spawn` → `prompt` → `close` per `buildTask` call. Slice 7's bounce-back creates a new session (or re-ensures the same named session — `sessions ensure` is idempotent). Session records accumulate until pruned (ADR-003 deferred).
- **`build:` commit is always present** on the task branch after a successful build. `git log` shows `freeze: <slug>` → (agent commits if any) → `build: <slug>`. The validator diffs against this HEAD.
- **Slice 6 reuses the run log schema.** The validator run is a `runs` row with `role = 'validator'` and `agent_id = 'pi'`. No schema change needed in Slice 6.
- **Slice 7 reuses the run log for retry context.** The bounce-back prompt appends the last `error` event from the previous builder run. The `runs` table's `prompt` and `error` columns are the source.
- **`task show` (Slice 7) gains run history.** `SELECT * FROM runs WHERE task_id = ? ORDER BY started_at` gives the full attempt history. Slice 7's `task show` enhancement reads from here.
- **Open ADR question #2 (builder prompt) is settled; validator half stays deferred.** This ADR defines the builder template only. Slice 6 defines the validator prompt (which includes the diff + spec, a different composition).
- **Open ADR question #3 (run log schema) is settled.** The `runs` + `run_events` schema is the M0 run log. It covers both builder and validator runs.
- **Open ADR question #4 (configuration) is partially settled.** Builder defaults: agent `opencode`, timeout 1800s, permission `approve-all` — all from ADR-003 defaults, no new config keys. Broader config-location question (global vs per-repo vs env vs CLI) stays deferred.
- **Crash recovery is not handled in M0.** A `running` run row with no `ended_at` indicates a crashed build. The task is stuck in `building` with no valid transition out (no `building → ready` or `building → backlog` in the state machine). The human would need SQL surgery to re-queue. Slice 10 (escape-hatch state transitions) will add manual recovery transitions; until then, a bricked task is a visible signal to investigate.

## Open questions (deferred)

- **Validator prompt template.** Slice 6 composes the validator prompt from the diff + spec. Different composition from the builder; Slice 6's ADR.
- **Builder config in `marshal.json`.** When the org needs to override the builder agent (`builder.agent`), timeout (`builder.timeoutSeconds`), model (`builder.model`), or prompt template (`builder.promptTemplate`), a `builder` section in `marshal.json` is the natural home. Not needed for M0 (one agent, one template, defaults from ADR-003).
- **Polling interval and loop control for `daemon start`.** Slice 9 decides the poll interval, graceful shutdown, and signal handling.
- **Run log retention/pruning.** `run_events` grows unboundedly. A retention policy (keep last N runs per task, or age-based) is a later daemon-housekeeping concern.
- **Prompt template override.** Per-repo or per-task prompt customization via config. Deferred until there's a concrete need beyond the default template.
- **Stale-run recovery.** Detecting `running` runs with no `ended_at` after a crash and marking them `error`. A future slice adds a startup sweep.
- **Escape-hatch state transitions.** Decision 7 leaves failed builds stuck in `building` with no valid transition out. Slice 10 (`docs/M0-VERTICAL-SLICES.md`) will add manual recovery transitions (e.g. `building → ready`, `building → backlog`) so the human can re-queue or cancel without SQL surgery. Slice 7's automated retry routing is separate.
- **Rebasing the task branch on trunk before building.** ADR-004 defers mid-flight rebases to Slice 6/7. If trunk advances between freeze and build, the builder works on a potentially stale base. For M0 (concurrency 1, short windows) this is acceptable.

## Related

- `docs/M0-VERTICAL-SLICES.md` Slice 5 — implementing scope.
- `docs/PROJECT.md` §5 (the loop, board states), §6 (in-loop vs boundary gate), §7 (spec freeze — builder-reads-file principle deviated by Decision 3), §6 (concurrency 1) — the design contract this ADR implements and amends.
- `docs/adr/ADR-003-agent-adapter-and-acpx.md` — the `Agent` interface, session strategy, permission defaults, and event types that `buildTask` consumes. Deferred run-log schema is settled here.
- `docs/adr/ADR-005-spec-freeze-at-ready.md` — the freeze that creates the worktree + spec file; the "run-once will refuse to build from a task that has no frozen spec" rule enforced in Decision 2; the "builder reads the spec from that file, not from SQLite" principle is **deviated** by Decision 3 (inline from SQLite instead). The frozen file remains the audit trail and the validator's source.
- `docs/adr/ADR-004-worktree-base-branch-policy.md` — the `origin/<trunk>` base that the `build:` commit lands on top of.
- `docs/adr/ADR-002-worktree-isolation.md` — the `WorktreeManager.create(slug)` idempotent-return behavior that `runOnce` relies on.
- `src/tasks/state-machine.ts:3` — `VALID_TRANSITIONS` (`ready → building → validating`).
- `src/tasks/store.ts:87` — `transitionTask` (the claim primitive).
- `src/agent/types.ts` — `Agent`, `AgentEvent`, `SpawnOptions` types consumed by `buildTask`.
- `src/agent/acpx-adapter.ts:14` — `AGENT_TOKENS` and the `AcpxAgentAdapter` that production code constructs.
- `src/tasks/freeze.ts:50` — `specRelPathFor(slug, taskId)` gives the spec path the pre-flight check verifies.
- `src/worktree/manager.ts:147` — the `create(slug)` short-circuit that returns the frozen worktree.
- `src/db/schema.sql` — where the `runs` and `run_events` tables are added.
