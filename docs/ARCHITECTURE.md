# Architecture

The consolidated reference for Marshal. `PROJECT.md` owns the vision and design tenets (_why_); this document owns the concrete shape of the system (_what_). For implementation-level detail — file paths, config keys, constants, prompt templates — read the code directly.

---

## 1. Task state machine

Statuses:

| Status       | Meaning                                                               |
| ------------ | --------------------------------------------------------------------- |
| `backlog`    | Working spec is mutable in SQLite; task is not yet buildable.         |
| `ready`      | Spec is frozen and committed; worktree exists; builder can claim it.  |
| `building`   | A builder agent is running (or has just failed) in the task worktree. |
| `validating` | A validator agent is running against the build commit.                |
| `review`     | Human review; diff is visible; can be merged or sent back.            |
| `done`       | Merged and cleaned up. Terminal.                                      |

Transitions:

```
backlog    → ready
ready      → building
building   → validating, ready*, backlog*
validating → building, review, backlog*
review     → done, backlog*
done       → (none)

* = escape hatch (human-driven only; resets retry_count and last_failure)
```

The orchestrator drives automated edges. Escape hatches are reached only via explicit human action (CLI or API). `transitionTask` is the single function that changes status; it enforces the graph inside a SQLite transaction.

### Retry state

`retry_count` tracks validator failures consumed. The default cap is 2 retries (3 total attempts). On cap exceeded, the task escalates to `review` with a failure summary. A passing validation resets the counter. Builder errors do **not** consume the retry budget — they leave the task stuck in `building` for human inspection.

---

## 2. HTTP / WebSocket API

All under `127.0.0.1:<port>` (default `7433`). Hono for routing; `ws` library for WebSocket upgrade on the same Node server.

### Routes

| Method | Path                                   | Purpose                                                   |
| ------ | -------------------------------------- | --------------------------------------------------------- |
| GET    | `/api/health`                          | Health check.                                             |
| GET    | `/api/tasks`                           | List tasks.                                               |
| GET    | `/api/tasks/:slug`                     | One task (board fields + spec + retry state).             |
| POST   | `/api/tasks`                           | Create a `backlog` task.                                  |
| POST   | `/api/tasks/:slug/transition`          | Body `{ to }`. Enforces state machine.                    |
| POST   | `/api/tasks/:slug/ready`               | Freeze spec and move to ready (distinct from transition). |
| GET    | `/api/tasks/:slug/diff`                | Unified diff of task branch vs trunk.                     |
| POST   | `/api/tasks/:slug/merge`               | Local `git merge --no-ff` into trunk.                     |
| GET    | `/api/tasks/:slug/runs`                | All runs for a task.                                      |
| GET    | `/api/runs/:id`                        | One run (includes prompt).                                |
| GET    | `/api/runs/:id/events?after_seq&limit` | Paginated run events.                                     |
| GET    | `/api/tasks/:slug/spec-messages`       | Spec-authoring chat history.                              |
| POST   | `/api/tasks/:slug/spec-messages`       | Send a user message; invokes the spec author agent.       |
| POST   | `/api/tasks/:slug/spec`                | Replace `spec_markdown` with proposed text.               |
| GET    | `/ws`                                  | WebSocket event stream.                                   |
| GET    | `/`, `/assets/*`                       | Static SPA.                                               |

Error envelope: `{ "error": "human message", "code": "machine_code" }`. Status codes: 400 (malformed), 404 (not found), 409 (lifecycle conflict), 422 (semantic error), 500 (unexpected).

The freeze endpoint (`POST .../ready`) is intentionally separate from the transition endpoint because freeze has filesystem + git side effects; conflating it with a pure state move makes error recovery ambiguous.

### WebSocket events

On connect, the server sends a `connected` event with a full task snapshot. Subsequent events are deltas: `task.created`, `task.updated`, `task.transitioned`, `run.started`, `run.event`, `run.finished`, `daemon.idle`, `daemon.cycle_complete`, `spec.message`.

Events are broadcast **only after** the underlying durable write succeeds. No replay buffer or sequence numbers — reconnect for a fresh snapshot. Server pings every 30s; drops clients silent for 90s.

---

## 3. Data model

SQLite, WAL mode. Four tables:

- **`tasks`** — `slug` (unique), `title`, `status`, `spec_markdown`, `retry_count`, `last_failure`.
- **`runs`** — one row per build or validate attempt. Links to `task_id`, tracks `role` (builder/validator), `agent_id`, `status`, `prompt`, `commit_sha`, timestamps, `error`.
- **`run_events`** — one row per agent event within a run, with monotonic `seq` for ordering and JSON `payload`. Inserted as events stream in (not buffered).
- **`spec_messages`** — chat history for the spec-authoring phase. `role` is `user` or `assistant`.

---

## 4. Worktree model

One worktree per task, created at the Ready transition, reused by both builder and validator.

- **Location**: `~/.marshal/worktrees/<repo-hash>/<slug>-<descriptor>/`. Overridable via config.
- **Branch**: `marshal/task/<slug>-<descriptor>`, based on `origin/<trunk>` (auto-detected, with fetch before branch creation). The source checkout is never mutated.
- **`.worktreeinclude`**: gitignore-syntax file at repo root listing gitignored files to copy into new worktrees (e.g. `.env`).
- **Setup**: optional shell command from `marshal.json` → `worktree.setup`, run after worktree creation.
- **Idempotent**: `create(slug)` returns the existing worktree if one exists. This lets freeze, builder, validator, and manual re-queue all share one worktree without re-running setup.
- **Cleanup**: worktree is destroyed only on successful merge to `done`. Escape hatches preserve it.

---

## 5. Agent layer

Marshal is agent-agnostic. The `Agent` interface (spawn, prompt, cancel, close) is the only abstraction the orchestrator depends on. The ACPX adapter is the sole implementation — Marshal shells out to the `acpx` CLI (never imports it as a library).

- **`AgentId`** is a plain string. Any ACP-compatible agent works by config alone. No allowlist or registry at runtime.
- **Session scope**: `(agentCommand, cwd, name)`. Builder and validator share the same worktree (`cwd`) but have distinct session names.
- **Events**: ACPX streams NDJSON; the adapter maps ACP `session/update` notifications to a typed `AgentEvent` union (text, thinking, tool, permission, log, done, error). Unknown variants pass through as log events.
- **Permission mode**: `approve-all` for all roles (headless, no TTY). ACPX handles permission enforcement.
- **Version pin**: ACPX version is pinned by semver range. A mismatch logs a warning on daemon startup.

Misconfiguration surfaces at `spawn` time, not config load. An unknown agent produces a child-process error surfaced as a run event.

---

## 6. Build → validate → review flow

The daemon runs a polling loop (`runOnce` per cycle). Each cycle claims the oldest `ready` or `validating` task (FIFO, `ready` wins ties to keep the pipeline moving).

### Builder (ready → building → validating)

1. Worktree exists from the freeze. Transition to `building`.
2. Spawn builder agent in the worktree. Stream events to the run log and WebSocket bus.
3. On completion, commit with `git add -A && git commit --allow-empty -m "build: <slug>"`. The `--allow-empty` ensures a clear build commit even if the agent committed internally.
4. Transition to `validating`. On error, task stays in `building` for human inspection.

The builder prompt inlines the spec from SQLite (not from the frozen file) and instructs the agent to follow repo conventions, write tests, and run checks. The in-loop gate (typecheck, lint, tests) is the builder's own responsibility — the orchestrator does not verify it.

### Validator (validating → review or → building for retry)

1. Reuses the builder's worktree (no second worktree). Computes diff against trunk, excluding `specs/`.
2. Spawn validator agent. The prompt includes the spec and diff, and instructs the agent to run the test suite and emit a gate sentinel.
3. Parse text events for `MARSHAL_GATE: pass` or `MARSHAL_GATE: fail <reason>`. First well-formed match wins. Missing sentinel = conservative `fail`.
4. On pass → `review`. On fail → bounce to `building` (retry accounting). On cap exceeded → escalate to `review` with failure summary.

The gate signal is a sentinel in agent text output — deterministic and auditable, not free-form model judgment.

### Review (review → done or → backlog)

- **Approve & Merge**: `git merge --no-ff` into trunk, transition to `done`, destroy worktree. Merge conflicts return 409 and leave the task in `review`.
- **Send Back**: escape hatch to `backlog`. Preserves worktree and commit history for inspection.

---

## 7. Spec lifecycle

Two artifacts per task:

1. **Working spec** (SQLite, mutable): `tasks.spec_markdown`. Editable during backlog via the spec-authoring chat. The agent is prompted to include proposed spec revisions in a fenced `marshal-spec` block; the human chooses whether to apply.
2. **Frozen spec** (committed file, immutable): At the Ready transition, the spec is written to `specs/<NNNN>-<slug>.md` in the worktree with YAML front-matter and committed. The frozen file is for auditability and git history; the builder prompt reads from SQLite.

Re-freezing creates a new commit (not an amend) — audit trail preserved.

---

## 8. Security and isolation

The daemon is an **RCE-as-a-service** surface — it spawns agents with file/exec permissions. It binds to `127.0.0.1` only. Any exposure beyond localhost requires an authenticated tunnel or token-based auth. An unauthenticated listener reachable beyond localhost is never acceptable.

ACPX does **not** sandbox the agent. The agent runs on the host with its own permissions. Isolation (container, VM) is the operator's responsibility. The worktree is the current filesystem scope boundary — the agent could escape it.

Provider API keys are the user's responsibility. Marshal never reads or stores them.

### Crash recovery

If the daemon dies mid-build or mid-validate, the task is **not** auto-retried. The worktree is preserved, the in-flight run stays in `running` status, and the operator re-queues manually via escape hatches. Conservative by design.

---

## 9. Onboarding

`marshal init` is **non-interactive** — running it is the consent. Flow:

1. Check system prereqs (node, git, pnpm).
2. Hard-gate on acpx presence. If missing, print the install command and exit. Marshal never installs acpx itself.
3. Write `~/.marshal/config.json` with agent role defaults if not already configured.
4. Create `.marshal/` and `.marshal/state.db` for the current repo.

`marshal doctor` is the read-only diagnostic. It re-runs prereq checks and probes each configured agent via a zero-token ACPX session handshake (`sessions new` + `close`). Marshal never checks provider env vars (e.g. `OPENAI_API_KEY`) — the session probe is the authoritative "can this agent run" signal.

---

## 10. Frontend

Plain Vite + React SPA in `web/`, built to `web/dist/`, served by the daemon. The Vite dev server proxies `/api/*` and `/ws` to the daemon.

The board is a thin client: initializes from the `connected` WebSocket snapshot, applies event deltas, and reconciles on reconnect. No durable client-side state. The board renders six columns matching the state machine, with task cards showing title, slug, and time-in-state. Task detail includes spec, diff view, run log, and spec-authoring chat.

Optimistic updates on mutations; rollback on server error. The server-side state machine is always authoritative — the UI hides invalid actions but does not enforce them.
