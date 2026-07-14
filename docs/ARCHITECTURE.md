# Architecture

The consolidated reference for Marshal. `PROJECT.md` owns the design tenets and vision; this document owns the concrete shape of the system as it is built today.

Read this when you need to know _what something does_ and _where it lives_. For _why_, see `PROJECT.md` (tenets) and `git log --follow` on the relevant file (rationale per change). Archived milestones and ADRs are gone from the working tree; git history is the archaeology layer.

---

## 0. Quick reference

### 0.1 Task state machine

Statuses (`src/tasks/state-machine.ts`):

| Status       | Meaning                                                               |
| ------------ | --------------------------------------------------------------------- |
| `backlog`    | Working spec is mutable in SQLite; task is not yet buildable.         |
| `ready`      | Spec is frozen and committed; worktree exists; builder can claim it.  |
| `building`   | A builder agent is running (or has just failed) in the task worktree. |
| `validating` | A validator agent is running against the build commit.                |
| `review`     | Human review; diff is visible; can be merged or sent back.            |
| `done`       | Merged and cleaned up. Terminal.                                      |

Valid transitions:

```
backlog    → ready
ready      → building
building   → validating, ready, backlog         ← +ready, +backlog are escape hatches
validating → building, review, backlog          ← +backlog is an escape hatch
review     → done, backlog                      ← +backlog is an escape hatch (Send Back)
done       → (none)
```

`ESCAPE_HATCH_TRANSITIONS` (`src/tasks/state-machine.ts:12`) is the canonical set of human-driven edges; `transitionTask` clears `retry_count` and `last_failure` when crossing any of them.

### 0.2 HTTP API

All under `127.0.0.1:<port>` (default `7433`). `src/daemon/http.ts` is the route owner; domain logic lives in `src/tasks/`, `src/worktree/`, `src/daemon/`, and is invoked directly — never shelled out.

| Method | Path                                   | Purpose                                              |
| ------ | -------------------------------------- | ---------------------------------------------------- |
| GET    | `/api/health`                          | `{ status: "ok", version }`.                         |
| GET    | `/api/tasks`                           | List tasks (board fields).                           |
| GET    | `/api/tasks/:slug`                     | One task (board + spec_markdown + retry state).      |
| POST   | `/api/tasks`                           | Create a `backlog` task.                             |
| POST   | `/api/tasks/:slug/transition`          | Body `{ to }`. Enforces state machine.               |
| POST   | `/api/tasks/:slug/ready`               | Freeze spec (optional override) and move to ready.   |
| GET    | `/api/tasks/:slug/diff`                | Unified diff of task branch vs trunk, plus stats.    |
| POST   | `/api/tasks/:slug/merge`               | Local `git merge --no-ff` of task branch into trunk. |
| GET    | `/api/tasks/:slug/runs`                | All runs for a task.                                 |
| GET    | `/api/runs/:id`                        | One run (includes `prompt`).                         |
| GET    | `/api/runs/:id/events?after_seq&limit` | Paginated run events (default 100, max 500).         |
| GET    | `/api/tasks/:slug/spec-messages`       | Spec-authoring chat history.                         |
| POST   | `/api/tasks/:slug/spec-messages`       | Send a user message; invokes the spec author agent.  |
| POST   | `/api/tasks/:slug/spec`                | Replace `spec_markdown` with proposed text.          |
| GET    | `/ws`                                  | WebSocket event stream.                              |
| GET    | `/`, `/assets/*`                       | Static SPA (served from `web/dist/`).                |

Error envelope (`src/daemon/http.ts`):

```json
{ "error": "human message", "code": "machine_code" }
```

| Status | Use                                                            |
| ------ | -------------------------------------------------------------- |
| 400    | Malformed JSON or unknown fields.                              |
| 404    | Unknown task slug / run id / static asset.                     |
| 409    | Lifecycle conflict (invalid transition, merge conflict, etc.). |
| 422    | Semantically invalid body (e.g. unknown status, empty spec).   |
| 500    | Unexpected daemon error.                                       |

### 0.3 WebSocket event bus

`src/daemon/ws.ts` (WebSocket transport) + `src/daemon/bus.ts` (pub/sub boundary). Every event is `{ type, payload, timestamp }` with an ISO-8601 timestamp set by the daemon. Events are broadcast **only after** the underlying durable write succeeds.

| Type                    | Payload                               | Emitted by                 |
| ----------------------- | ------------------------------------- | -------------------------- |
| `connected`             | `{ tasks: TaskPayload[] }` (snapshot) | WS handler on connect      |
| `task.created`          | `{ task }`                            | `tasks-api` on insert      |
| `task.updated`          | `{ task }`                            | `tasks-api` on update      |
| `task.transitioned`     | `{ task, from, to }`                  | `tasks-api` / orchestrator |
| `run.started`           | `{ run }`                             | `RunLog.startRun`          |
| `run.event`             | `{ runId, event }`                    | `RunLog.insertEvent`       |
| `run.finished`          | `{ run }`                             | `RunLog.finishRun`         |
| `daemon.idle`           | `{}`                                  | Loop when no ready task    |
| `daemon.cycle_complete` | `{}`                                  | Loop at end of `runOnce`   |
| `spec.message`          | `{ taskSlug, message }`               | spec-chat on persist       |

Heartbeat: server pings every 30s, drops clients silent for 90s. No replay / sequence numbers — reconnect to receive a fresh `connected` snapshot.

### 0.4 SQLite tables

`src/db/schema.sql`. WAL mode. Foreign keys on `task_id` references.

| Table           | Notable columns                                                                                                                  | Index                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `tasks`         | `id`, `slug` (unique), `title`, `status`, `spec_markdown`, `retry_count`, `last_failure`                                         | `idx_tasks_status`, `idx_tasks_slug`                 |
| `runs`          | `id`, `task_id`, `role` (`builder`/`validator`), `agent_id`, `status`, `prompt`, `commit_sha`, `started_at`, `ended_at`, `error` | `idx_runs_task_id`                                   |
| `run_events`    | `id`, `run_id`, `seq` (per-run monotonic), `type`, `payload` (JSON), `created_at`                                                | `idx_run_events_run_id(run_id, seq)`                 |
| `spec_messages` | `id`, `task_id`, `role` (`user`/`assistant`), `content`, `created_at`                                                            | `idx_spec_messages_task_id(task_id, created_at, id)` |

### 0.5 File / module map

```
src/
  cli.ts                       # commander entry; verb dispatch
  logger.ts                    # pino
  agent/
    types.ts                   # AgentId, AgentEvent, Agent interface
    acpx-adapter.ts            # ACPX CLI subprocess + NDJSON parser
  tasks/
    state-machine.ts           # VALID_TRANSITIONS, ESCAPE_HATCH_TRANSITIONS
    store.ts                   # createTask, getTask, transitionTask, retry helpers
    freeze.ts                  # freezeTask → specs/NNNN-slug.md commit
    spec-store.ts              # spec_messages CRUD
    slug.ts                    # generateUniqueSlug
    commands.ts                # `marshal task ...` CLI verbs
  worktree/
    config.ts                  # GlobalConfig, resolveAgentId, resolveMaxRetries
    manager.ts                 # WorktreeManager (create / destroy / lookup)
    include.ts                 # .worktreeinclude matcher
    name.ts                    # adjective-noun descriptor
    diff-merge.ts              # diff stats, merge --no-ff, NoTrunkRefError
  daemon/
    http.ts                    # Hono routes, error envelope
    ws.ts                      # WebSocket bridge
    bus.ts                     # EventBus + publish* helpers
    orchestrator.ts            # runOnce, buildTask, validateTask, prompt templates
    run-log.ts                 # RunLog CRUD + pagination
    loop.ts                    # startDaemon (poll loop)
    config.ts                  # initRepoState, initGlobalConfig, getRepoStateDir
    spec-chat.ts               # runSpecAuthorTurn (calls spec author agent)
  db/
    schema.sql                 # all tables
    index.ts                   # openDb (runs schema.sql on every open)
  setup/
    init.ts                    # marshal init (non-interactive)
    preflight.ts               # check functions, generateConfig
    hints.ts                   # AGENT_INSTALL_HINTS (advisory)
web/                           # Vite React SPA, served by daemon from web/dist/
tests/                         # CLI smoke + M0 loop integration
docs/
  PROJECT.md                   # design tenets, vision, state machine narrative
  ARCHITECTURE.md              # this file
  HUMAN-TESTING-GUIDE.md       # manual QA guide
  archived/milestones/         # historical M0/M1 vertical slices (no longer active)
```

### 0.6 Config keys

`~/.marshal/config.json` (resolved via `src/worktree/config.ts`). `marshal.json` (per-repo, optional) is read separately by `loadMarshalJson`.

| Key                                                           | Default              | Where read                                |
| ------------------------------------------------------------- | -------------------- | ----------------------------------------- |
| `acpx.bin`                                                    | `acpx`               | `acpx-adapter.ts` startup probe           |
| `acpx.version`                                                | `">=0.12.0 <0.13.0"` | `acpx-adapter.ts` startup warning         |
| `agents.builder`                                              | required             | `orchestrator.ts` via `resolveAgentId`    |
| `agents.validator`                                            | required             | `orchestrator.ts` via `resolveAgentId`    |
| `agents.specAuthor`                                           | required             | `spec-chat.ts` via `resolveAgentId`       |
| `policy.maxRetries`                                           | `2`                  | `orchestrator.ts` via `resolveMaxRetries` |
| `daemon.host`                                                 | `127.0.0.1`          | `http.ts` via `resolveDaemonBind`         |
| `daemon.port`                                                 | `7433`               | `http.ts` via `resolveDaemonBind`         |
| `worktree.root` (per-repo, `marshal.json` → `worktree.setup`) | unset                | `manager.ts`                              |

`resolveAgentId` throws `MissingAgentIdError` (no silent defaults) when a role key is absent; the message points at `https://acpx.sh/agents.html`. The `AGENT_ID_DEFAULTS` constant in `src/worktree/config.ts:90` is consulted **only** by `marshal init` when writing a fresh config, never at runtime.

### 0.7 Constants worth knowing

| Constant                    | Value             | Source                          |
| --------------------------- | ----------------- | ------------------------------- |
| `BUILDER_TIMEOUT_SECONDS`   | `1800`            | `src/daemon/orchestrator.ts:34` |
| `VALIDATOR_TIMEOUT_SECONDS` | `1800`            | `src/daemon/orchestrator.ts:36` |
| `BUILDER_PERMISSION_MODE`   | `"approve-all"`   | `src/daemon/orchestrator.ts:35` |
| `DIFF_MAX_LINES`            | `2000`            | `src/daemon/orchestrator.ts:38` |
| `GATE_SENTINEL`             | `"MARSHAL_GATE:"` | `src/daemon/orchestrator.ts:39` |
| `DEFAULT_RUN_EVENTS_LIMIT`  | `100`             | `src/daemon/run-log.ts:54`      |
| `MAX_RUN_EVENTS_LIMIT`      | `500`             | `src/daemon/run-log.ts:55`      |
| `DEFAULT_MAX_RETRIES`       | `2`               | `src/worktree/config.ts:107`    |
| `DEFAULT_DAEMON_HOST`       | `127.0.0.1`       | `src/worktree/config.ts:122`    |
| `DEFAULT_DAEMON_PORT`       | `7433`            | `src/worktree/config.ts:123`    |

---

## 1. Process and lifecycle

### 1.1 Install and distribution

`npm i -g sataycat/marshal` (GitHub-shorthand form, `package.json` `repository` points at `sataycat/marshal`). The install lifecycle runs `prepublishOnly` (safety net) and a `postinstall` that invokes `tsc` if `dist/` is missing. `bin/marshal` is a thin `#!/usr/bin/env node` ESM stub that imports `../dist/cli.js`.

Native module: `better-sqlite3`. Upstream's `prebuild-install` covers common platforms; long-tail installs need a C++ toolchain (python3, make, g++/clang). This is the main install-friction source.

### 1.2 One daemon per repo

`docs/PROJECT.md` §3.1 sets the process model. Each `marshal daemon start` binds one port for the current repo, writes `.marshal/daemon.port` (the resolved port, written **after** the listener accepts), and removes the file on clean shutdown. Clients discover the daemon by reading that file relative to the cwd-walked repo root (same model as `.git`).

Multiple repos on one host = multiple daemons, multiple ports. There is no global multiplexer.

### 1.3 Trust boundary

`http.ts` defaults to `127.0.0.1` and `resolveDaemonBind` (`src/worktree/config.ts:131`) warns loudly if the user explicitly passes a non-loopback host. The HTTP + WebSocket API has no auth layer in M0/M1: exposing the daemon beyond localhost requires an authenticated tunnel (SSH port-forward, Tailscale, or equivalent). The warning is logged and the bind proceeds because the user asked for it; the daemon does not silently widen.

The daemon can spawn coding agents with file/exec permissions (ACPX `--approve-all`). It is therefore an RCE-as-a-service surface when reachable. The `acpx-adapter.ts` permission default is `--approve-all --non-interactive-permissions fail` for both builder and validator.

### 1.4 Onboarding (`marshal init`)

`src/setup/init.ts`. **Non-interactive**: there are no prompts, no `--yes`, no `--non-interactive` flag. Running `marshal init` is the consent.

Flow:

1. **System prereqs** (`node`, `git`, `pnpm`). `pnpm` is a warning, not a fail. (`checkSystemPrerequisites` in `preflight.ts`.)
2. **acpx hard-gate** (`checkAcpx`). If `acpx` is missing or its version is outside the accept range, init prints a single install line (`npm i -g acpx@<pin>`) and exits non-zero. No in-process install attempt, no fake success marker.
3. **Fast path**: if `~/.marshal/config.json` already has `acpx` + `agents.builder` + `agents.validator`, print `✓ machine already configured` and skip to repo init.
4. **Config generation**: `generateConfig` writes the role defaults from `AGENT_ID_DEFAULTS` (`opencode` / `pi` / `opencode`) and the acpx bin/version. Existing user values are preserved.
5. **Repo init**: `initRepoState` creates `.marshal/` and `openDb` creates `.marshal/state.db`.

`marshal doctor` is the read-only diagnostic; it re-runs Phase 1–2 and probes each configured agent via `acpx <agent> sessions new` + `sessions close` (zero-token ACP handshake). It never mutates state.

---

## 2. Task state machine

`src/tasks/state-machine.ts` is the single source of truth for valid transitions. `transitionTask` (`src/tasks/store.ts`) is the only function that changes `tasks.status`; it asserts against `VALID_TRANSITIONS` inside a SQLite transaction.

### 2.1 Automated edges (driven by the orchestrator)

| From         | To           | Trigger                                                              |
| ------------ | ------------ | -------------------------------------------------------------------- |
| `backlog`    | `ready`      | `POST /api/tasks/:slug/ready` or `marshal task ready` (freezes spec) |
| `ready`      | `building`   | `runOnce` claim                                                      |
| `building`   | `validating` | `runOnce` after builder commits                                      |
| `validating` | `building`   | `runOnce` on validator non-pass (with retry accounting)              |
| `validating` | `review`     | `runOnce` on validator pass (or retry-cap exceeded)                  |
| `review`     | `done`       | `POST /api/tasks/:slug/merge` after successful local merge           |

### 2.2 Escape hatches (human-driven only)

`ESCAPE_HATCH_TRANSITIONS` (`src/tasks/state-machine.ts:12`). The orchestrator never drives these; they are reached only via `marshal task transition` or `POST /api/tasks/:slug/transition`.

| From         | To        | Use case                                        |
| ------------ | --------- | ----------------------------------------------- |
| `building`   | `ready`   | Re-queue a failed build after human inspection. |
| `building`   | `backlog` | Spec needs rework; send back to authoring.      |
| `validating` | `backlog` | Spec-level problem discovered by validator.     |
| `review`     | `backlog` | "Send Back" from the Review column.             |

When `transitionTask` crosses any of these, the same transaction clears `retry_count` to `0` and `last_failure` to `NULL`. The `task show` output on a stuck task surfaces the most recent `runs` row's error via `getLastRunForTask` so the human can decide between re-queue and back-to-authoring without querying the run log by SQL.

### 2.3 Retry state

`tasks.retry_count` counts validator failures already consumed. `tasks.last_failure` is the most recent failure reason (sentinel `fail <reason>`, or fallback `"unknown validation failure"` for absent sentinel / spawn failure / error event).

| Event                           | `retry_count` | `last_failure`                |
| ------------------------------- | ------------- | ----------------------------- |
| Validator pass                  | reset to `0`  | cleared                       |
| Validator fail, cap not reached | `+1`          | set to reason                 |
| Validator fail, cap reached     | unchanged     | set to reason (then escalate) |

The cap check uses `<` (not `<=`): with the default cap of `2`, the third failure sees `2 < 2 == false` and escalates to `review`. Builder errors do **not** consume validation retries — they leave the task in `building` per §6.5 and `last_failure` stays null.

`marshal task show` displays the retry count and last failure (when present). On a stuck task it also prints the most recent run's role, agent, and error.

---

## 3. Worktree model

`src/worktree/manager.ts`. One worktree per task, created at the Ready transition by the freeze flow (`src/tasks/freeze.ts`), and reused by both the builder and the validator (no second worktree for validation).

### 3.1 Location and naming

- **Root**: `~/.marshal/worktrees/<repo-hash>/<slug>-<descriptor>/`. `<repo-hash>` is the first 8 hex chars of `SHA-256(repoRoot)`. Root overridable via `~/.marshal/config.json` → `worktree.root`.
- **Branch**: `marshal/task/<slug>-<descriptor>`. `<descriptor>` is a memorable adjective-noun from `src/worktree/name.ts`, derived deterministically from the slug; numeric suffix on collision.
- **Base branch**: `origin/<trunk>`, not the source checkout's `HEAD`. `git fetch origin <trunk>` runs before branch creation. The source checkout is never mutated. Auto-detection: `git symbolic-ref refs/remotes/origin/HEAD`, falling back to `origin/main` → `origin/master` → `main` → `master`. Override via `marshal.json` → `worktree.base` (or `worktree.base: "HEAD"` to opt out of fetch).

### 3.2 `.worktreeinclude` and setup

A `.worktreeinclude` file at the repo root (gitignore syntax) lists gitignored files to copy into a new worktree (e.g. `.env`). Tracked files are not copied. Patterns matching `node_modules`, `.next`, `dist`, `target`, `build`, `coverage`, `.pnpm-store` are ignored with a warning.

`marshal.json` → `worktree.setup` is an optional shell command run after worktree creation with these env vars set:

- `MARSHAL_SOURCE_CHECKOUT_PATH`
- `MARSHAL_WORKTREE_PATH`
- `MARSHAL_TASK_SLUG`
- `MARSHAL_BRANCH_NAME`

The default setup is `pnpm install` (per-worktree dependencies; no shared `node_modules`).

### 3.3 Idempotency

`WorktreeManager.create(slug)` is idempotent: if a worktree record exists for the slug, it returns the existing one. This is what lets the freeze at Ready create the worktree, the builder at Building reuse it, the validator at Validating reuse it, and a manual re-queue (`building → ready`) reuse it again — all without re-running `git worktree add` or the setup script.

`WorktreeManager.destroy(slug)` removes the worktree directory and deletes the branch.

### 3.4 Diff base for the validator

The validator computes its diff against the auto-detected local trunk ref (see `detectTrunkRef` in `src/daemon/orchestrator.ts:83`). The fallback chain is:

1. `git symbolic-ref refs/remotes/origin/HEAD`
2. `git rev-parse --verify origin/main`
3. `git rev-parse --verify origin/master`
4. `git rev-parse --verify main`
5. `git rev-parse --verify master`
6. Throws `NoTrunkRefError` if all fail.

The `specs/` directory is excluded from the diff with `git diff <trunk>...HEAD -- . ':!specs/'` because the spec content is inlined into the prompt above the diff and double-printing it wastes context.

---

## 4. Spec lifecycle

Two distinct artifacts per task. The split is the build-contract boundary.

### 4.1 Working spec (SQLite, mutable)

`tasks.spec_markdown` (`src/db/schema.sql:6`). Lives in SQLite during the backlog / grill-me phase. Set at task creation (`POST /api/tasks` body `spec_markdown`, or `marshal task create --spec` / `--spec-file`). Mutated by:

- The spec-authoring chat: `POST /api/tasks/:slug/spec` replaces it with the human-confirmed proposed text.
- (No general `task update` exists; revision flows through Ready → Backlog escape hatch or direct SQL.)

The working spec is the source of truth until the Ready transition.

### 4.2 Frozen spec (committed file, immutable)

`src/tasks/freeze.ts`. At the Ready transition, `freezeTask(slug)`:

1. Refuses if the task is not in `ready` or the spec is empty (`FreezeError`).
2. Creates the worktree (idempotent — see §3.3).
3. Writes `specs/<NNNN>-<slug>.md` to the worktree, where `<NNNN>` is `String(task.id).padStart(4, '0')` (so task id 42 → `specs/0042-foo.md`).
4. Commits with message `freeze: <slug>` (no body, no trailers).

The frozen file is YAML front-matter + verbatim body:

```markdown
---
slug: <slug>
title: "<title>" # JSON-string-quoted to avoid YAML edge cases
task_id: <id>
frozen_at: <iso8601>
---

<spec_markdown body verbatim>
```

The builder's prompt (§6.2) inlines the spec from SQLite, not from the file. The file exists for auditability, for the validator's diff-exclusion, and as the institutional-memory record that persists in main after merge.

### 4.3 Re-freeze

Re-running `freezeTask` on a task whose branch already has a `freeze: <slug>` commit creates a **new** commit on top, not an amend. The audit trail is preserved: every freeze is a discrete decision. `WorktreeManager.create(slug)` returning the existing record means the second freeze does not create a second worktree.

### 4.4 Failure leaves the task in `ready`

`marshal task ready` is two operations — `transitionTask(slug, "ready")` and `freezeTask(slug)` — that cannot share a transaction. A crash between them leaves the task in `ready` with no frozen file. Recovery is `marshal task freeze <slug>`. The CLI error message points at the recovery command.

### 4.5 Boundary test files

Per `docs/PROJECT.md` §6, the spec and the boundary test files freeze together as one atomic build contract at Ready. Any modification to a frozen boundary test file during Building is a gate-integrity violation routed to human Review rather than allowed to auto-advance. (The M0 implementation does not yet enforce this mechanically — it is a documented invariant the gate will check once the M2 boundary-gate work lands.)

---

## 5. Agent layer

### 5.1 Interface

`src/agent/types.ts`. The `Agent` interface is the only abstraction the orchestrator depends on. The ACPX adapter is the only implementation.

```ts
export type AgentId = string; // any non-empty string; passed to ACPX as-is

export interface AgentSession {
  agentId: AgentId;
  cwd: string; // absolute worktree path; ACPX session scope
  name: string; // "marshal-<slug>-<role>"
  recordId?: string; // acpx record id (diagnostics)
}

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; title: string; status?: string; output?: string }
  | { type: "permission"; tool: string; granted: boolean }
  | { type: "log"; stream: "stdout" | "stderr"; text: string }
  | { type: "done"; stopReason: string }
  | { type: "error"; message: string; code?: number };

export interface Agent {
  spawn(cwd: string, agentId: AgentId, opts?: SpawnOptions): Promise<AgentSession>;
  prompt(session: AgentSession, text: string, opts?: PromptOptions): AsyncIterable<AgentEvent>;
  cancel(session: AgentSession): Promise<void>;
  close(session: AgentSession): Promise<void>;
}
```

Note: `streamEvents(session)` from the original PROJECT.md design is **gone** — events are returned from `prompt` as an `AsyncIterable`, because ACPX runs one streaming subprocess per prompt and a separate stream call would race it.

### 5.2 ACPX is the sole substrate

Marshal shells out to the `acpx` CLI (Node `child_process.spawn`, never imports `acpx` as a library). The contract is: `acpx` on PATH, version in the pinned range, raw ACP JSON-RPC NDJSON on stdout. Per ACPX's CLI reference, there is no acpx-specific event envelope — one JSON message per line.

- `spawn` → `acpx <agent> sessions ensure --name <name> --cwd <cwd> --format json --json-strict`
- `prompt` → `acpx <agent> -s <name> --cwd <cwd> --format json --json-strict [opts]` (stdin for the prompt text to avoid argv-length limits)
- `cancel` → `acpx <agent> cancel -s <name> --cwd <cwd>`
- `close` → `acpx <agent> sessions close <name> --cwd <cwd>`

### 5.3 Session scope

`(agentCommand, cwd, name)`. Builder and validator share the same `cwd` (the builder's worktree) but have different `name`s: `marshal-<slug>-builder` and `marshal-<slug>-validator`. Per-worktree `cwd` is what guarantees no session collision across tasks.

Persistent sessions (`sessions ensure` + named `-s`) are used instead of one-shot `exec` so that:

- ACPX's crash-reconnect works (PID dead → respawn → `session/resume` → `session/load` → `session/new` fallback).
- Multi-turn follow-ups (validator retry with appended context) work without changing the interface.

### 5.4 Permission and timeout defaults

| Role        | `permissionMode` | `timeoutSeconds` |
| ----------- | ---------------- | ---------------- |
| Builder     | `approve-all`    | `1800`           |
| Validator   | `approve-all`    | `1800`           |
| Spec author | `approve-all`    | (ACPX default)   |

`--approve-all --non-interactive-permissions fail` is passed to ACPX. `fail` is belt-and-braces: with `--approve-all` no prompt should reach the non-interactive path, but if one does we fail fast.

### 5.5 Event mapping

`session/update` notifications on the NDJSON stream are mapped to `AgentEvent`:

- `agent_message_chunk` with `content.type === "text"` → `{ type: "text", text }`
- Thinking/tool variants → `{ type: "thinking" }` / `{ type: "tool" }`
- Request `result` with `stopReason` → `{ type: "done", stopReason }` (generator ends)
- `session/request_permission` → `{ type: "permission", tool, granted: true }`
- Unknown `sessionUpdate` variants **pass through** as `{ type: "log", stream: "stdout", text: <raw json line> }` so the adapter never drops data when ACP adds a new update kind.
- Process exit non-zero without a `done` event → `{ type: "error", message, code }` mapped from ACPX exit codes (`3` → timeout, `4` → no session, `5` → permission denied, `130` → interrupted, `1` → agent error).

### 5.6 Coding-agent agnosticism

`AgentId` is a plain `string` (not a literal union). `resolveAgentId(role)` returns the configured id verbatim or throws `MissingAgentIdError` — it does **not** consult any allowlist, registry, or default at runtime. The `AGENT_ID_DEFAULTS` constant is only read by `marshal init` to seed a fresh config.

Any ACP-compatible agent can be plugged in by config alone — `claude`, `codex`, `gemini`, `kimi`, `mux`, `qoder`, `droid`, `grok-build`, etc. ACPX has a built-in registry at `https://acpx.sh/agents.html` that maps friendly names to adapter commands; the `AGENT_INSTALL_HINTS` table in `src/setup/hints.ts` mirrors that registry as an **advisory** install/diagnostics table. Omitting an entry there is fine — Marshal will still pass the id to ACPX, and ACPX's own startup handshake will surface auth or binary errors.

Misconfiguration surfaces at `spawn` time (not config load). A user who names an agent that ACPX doesn't know gets a child-process ENOENT or an ACPX "unknown agent" error, surfaced as a run event.

### 5.7 ACPX version pin

`acpx.version` (config) / `ACPX_ACCEPT_RANGE` (code, currently `">=0.12.0 <0.13.0"`) / `ACPX_INSTALL_PIN` (currently `0.12.0`). The pin exists because ACPX's CLI grammar and NDJSON shape are Marshal's versioned API contract per ACPX's VISION Principle 4. A minor-bump warning is logged on daemon startup; it is not a hard fail because a 0.12 → 0.13 transition is a normal semver bump against a stability-committed CLI, but operators should notice before a subtle flag rename bites them.

---

## 6. Build run

`src/daemon/orchestrator.ts`. The orchestrator has one main entry point — `runOnce(root?, agent?, manager?)` — that does both build and validate dispatch.

### 6.1 FIFO dispatch

`runOnce` selects the oldest task whose status is `ready` or `validating` (`ORDER BY created_at ASC, id ASC LIMIT 1`). A `ready` task that has been waiting longer than a `validating` task should not be starved. `ready` wins ties because the builder's output is the validator's input — processing a `ready` task first keeps the pipeline moving when the queue is mixed.

Within the same `created_at` tie, `ready` is selected first by status ordering.

### 6.2 Builder flow

For a `ready` task:

1. **Pre-flight**: `WorktreeManager.create(slug)` returns the existing worktree (from the freeze). `specs/<NNNN>-<slug>.md` must exist; otherwise the task stays in `ready` with `{ status: "skipped" }` and a recovery hint pointing at `marshal task freeze <slug>`.
2. **Claim**: `transitionTask(slug, "building")` inside a SQLite transaction.
3. **Spawn**: `agent.spawn(worktree, resolveAgentId("builder"), { permissionMode: "approve-all", timeoutSeconds: 1800 })`.
4. **Prompt**: render the builder template and call `agent.prompt(session, prompt)`. The session name is `marshal-<slug>-builder`.
5. **Stream**: every `AgentEvent` from the async iterable is written to `RunLog` (one `run_events` row per event with monotonic `seq`) and broadcast as `run.event` over the bus. The run's `status` is set to `done` or `error` on the terminal event.
6. **Commit**: `git add -A && git commit --allow-empty -m "build: <slug>"` in the worktree. `--allow-empty` is deliberate: it ensures a `build:` commit is always present (clear "build HEAD" for the validator diff, audit marker for the run log) even if the builder committed internally or made no changes.
7. **Route**: on `done` → `transitionTask(slug, "validating")`. On `error` → task stays in `building` (see §6.5).
8. **Close**: `agent.close(session)` in a `finally` block so the session is cleaned up even on error.

### 6.3 Builder prompt

Rendered by `renderBuilderPrompt(task)` (`src/daemon/orchestrator.ts`). The spec is inlined directly from `task.spec_markdown` (no tool call, no file read, no double-spec):

```
You are working on task "{title}" (slug: {slug}).

## Spec

{spec_markdown}

## Instructions

Follow repo conventions (see AGENTS.md if present). Write tests for new code. Run type-checks and tests before finishing.

Do not commit — your changes will be committed automatically when you finish.
```

Notes:

- The frozen spec file's front-matter is metadata for git audit, not for the agent; inlining from SQLite skips it naturally.
- "Do not commit" is advisory. The orchestrator's `git add -A` + `--allow-empty` absorbs any agent-made commits and folds them into the `build:` commit.
- The in-loop gate (typecheck, lint, unit tests) is the builder's own responsibility — the orchestrator does not parse builder tool-call output for test results or re-run any checks. The boundary validator (§7) is the real gate.

The rendered prompt is stored in `runs.prompt` for auditability.

### 6.4 Run log schema

Two tables (`src/db/schema.sql`). One `runs` row per build or validate attempt (a task that bounces back from validation gets a new `runs` row with the same `task_id` and `role = "builder"`). One `run_events` row per `AgentEvent`, inserted as it arrives (streaming, not buffered), with `seq` preserving order and `payload` containing the JSON-encoded event.

`RunLog` (`src/daemon/run-log.ts`) wraps these inserts:

```ts
startRun(taskId, role, agentId, prompt): number       // returns runId
insertEvent(runId, seq, event): void
finishRun(runId, status, { commitSha?, error? }): void
getRun(runId): RunRecord | undefined
getEvents(runId, { afterSeq?, limit? }): RunEventRecord[]
listRunsForTask(taskId): RunRecord[]
getLastRunForTask(taskId): RunRecord | undefined
```

The HTTP layer uses `listRunsForTask` / `getRun` / `getEvents` for `/api/tasks/:slug/runs` and `/api/runs/:id{,/events}`. Pagination uses `seq` as the cursor (default limit `100`, max `500`).

### 6.5 Builder failure handling

| Failure                                 | Task state       | Run status | Action                                            |
| --------------------------------------- | ---------------- | ---------- | ------------------------------------------------- |
| Agent stream ends with `{type:"error"}` | stays `building` | `error`    | Log error; do not commit; do not transition       |
| Agent timeout (ACPX exit 3)             | stays `building` | `error`    | Same as above                                     |
| Agent `spawn` throws                    | stays `building` | `error`    | Record error; no events                           |
| Builder commit fails (git error)        | stays `building` | `error`    | Record error; partial changes may be in worktree  |
| Process crash mid-build                 | stays `building` | `running`  | Stale `running` row; human intervenes (see §15.4) |

Builder errors do **not** consume the validation retry budget (see §2.3). The task is observably stuck in `building`; `marshal task show` displays the run's error so the human can choose between re-queue (`building → ready`) and back-to-authoring (`building → backlog`).

### 6.6 In-loop gate

The in-loop gate (typecheck, lint, unit tests) is the builder's own workflow. The orchestrator's prompt instructs the builder to self-iterate on fast gates; the orchestrator does not verify gate results. The boundary validator (§7) is the real gating signal.

---

## 7. Validation run and gate

`src/daemon/orchestrator.ts`. The validator is the boundary gate — the second-line check the design stakes the product on.

### 7.1 Decorrelated agent, same fs

The validator uses `resolveAgentId("validator")` (default `pi`) — typically a different agent family from the builder. Decorrelation comes from **the agent**, not from the filesystem.

The validator reuses the builder's worktree (no `git worktree add`, no include copy, no setup script re-run). The builder's `--allow-empty` commit (§6.2) leaves the worktree at a clean build commit. Creating a second worktree for the validator would add cost without isolation benefit, because the validator's role is read + run tests, not modify the tree.

The validator's session name is `marshal-<slug>-validator`. Same `cwd` as the builder (different `name` makes it a distinct session under the scope key).

### 7.2 Validator flow

For a `validating` task:

1. **Pre-flight**: worktree still exists, build commit present (the orchestrator only claims validating tasks whose builder run is `done`).
2. **Spawn**: `agent.spawn(worktree, resolveAgentId("validator"), { permissionMode: "approve-all", timeoutSeconds: 1800 })`.
3. **Diff**: `git diff <trunk>...HEAD -- . ':!specs/'` truncated to `DIFF_MAX_LINES` (2000).
4. **Prompt**: render the validator template and call `agent.prompt(session, prompt)`.
5. **Sentinel scan**: parse text events for `MARSHAL_GATE: pass` or `MARSHAL_GATE: fail <reason>`. First well-formed match wins.
6. **Route**: on pass → `validating → review` (with retry reset). On any non-pass → `validating → building` (with retry accounting) or, on cap exceeded, `validating → review` with failure summary.
7. **Close**: `agent.close(session)` in `finally`.

### 7.3 Validator prompt

```
You are validating the implementation of task "{title}" (slug: {slug}).

## Spec

{spec_markdown}

## Diff (truncated to 2000 of <N> lines)

Base: <trunkRef>
Run `git diff <trunkRef>...HEAD` in this directory to see the full diff if needed.

<diff>

## Instructions

1. Read the spec above carefully.
2. Inspect the diff above. Run the project's test suite, type-check, and any other
   checks that match the spec's acceptance criteria. Use the file system and shell
   freely; you are in the build's worktree.
3. Decide: do the changes satisfy the spec? Are the tests passing? Is the diff
   minimal and correct?
4. When you have decided, output exactly one final line and stop:

   MARSHAL_GATE: pass

   or

   MARSHAL_GATE: fail <one-sentence reason>
```

### 7.4 Gate signal

The gate is a sentinel in the agent's text output:

```
MARSHAL_GATE: pass
MARSHAL_GATE: fail <reason>
```

Parsed by `parseGateSentinel` in `src/daemon/orchestrator.ts:115` against the `text` events only. Other event types (tool, log, thinking) don't carry the gate. Multiple matches: first well-formed line wins. A missing or malformed sentinel is treated conservatively as `fail` with reason `"no gate decision emitted"`.

The sentinel stays in text (not a new `AgentEvent` variant) so the `Agent`/`AgentEvent` protocol stays generic across builder, validator, and any future role. Marshal-specific gate semantics live in the orchestrator, not the agent protocol.

### 7.5 Routing table

| Validator outcome                        | Task transition         | `RunOnceResult.status`                                     |
| ---------------------------------------- | ----------------------- | ---------------------------------------------------------- |
| `pass` (sentinel `pass`)                 | `validating → review`   | `validated`                                                |
| `fail` (sentinel `fail <reason>`)        | `validating → building` | `validation_failed`                                        |
| `absent` (no sentinel)                   | `validating → building` | `validation_failed` (reason: `"no gate decision emitted"`) |
| `spawn` throws                           | `validating → building` | `validation_failed` (reason: `"spawn failed: ..."`)        |
| Stream `error` event                     | `validating → building` | `validation_failed` (reason: `<event.message>`)            |
| Timeout (ACPX exit 3)                    | `validating → building` | `validation_failed` (reason: `"timeout"`)                  |
| Cap exceeded (regardless of fail reason) | `validating → review`   | `validation_failed`                                        |

The task is **never** left in `validating` on a non-pass outcome. The state machine has no `validating → validating` edge; bouncing to `building` is the only way to keep the queue moving. The retry cap (§2.3) bounds the resulting loop.

The failure reason is stored on the validator's `runs` row in the `error` column and mirrored to `tasks.last_failure`. The validator does not commit; the `build:` commit is the only orchestrator-produced commit on the task branch.

---

## 8. Loop, retry cap, and failure routing

### 8.1 Daemon loop

`src/daemon/loop.ts` exports `startDaemon(opts)` — a polling loop over `runOnce` with a configurable interval and an `AbortSignal` stop. On each cycle, if no `ready`/`validating` task is claimed, the bus publishes `daemon.idle`; otherwise it publishes `daemon.cycle_complete` at the end. SIGINT / SIGTERM stop the loop and close the HTTP server in one graceful shutdown sequence.

`marshal daemon run-once` calls `runOnce` once, prints a one-line result, and exits. `marshal daemon start` is the long-running poll.

### 8.2 Retry cap

`policy.maxRetries` (`src/worktree/config.ts:40`), default `2` (`DEFAULT_MAX_RETRIES`). The cap is a count of _retries_ (not total attempts): with the default cap, a task may be validated up to three times — initial + 2 retries — before escalation. A passing validation resets the counter (`retry_count = 0`, `last_failure = NULL`) so a future manual re-queue starts with a fresh budget.

The cap check in `runOnce` is `if (retry_count < maxRetries) bounce, else escalate`.

### 8.3 Spend ceiling (planned, not enforced)

`docs/PROJECT.md` §5.2 calls out a per-task spend ceiling alongside the step budget. The M0/M1 implementation tracks `retry_count` (a proxy for spend via retries) but does not yet track token/cost explicitly. This is a documented invariant, not a current feature.

---

## 9. HTTP API

`src/daemon/http.ts`. Hono for routing, `@hono/node-server` for the Node listener, `ws` for the WebSocket upgrade handler. Hono does **not** own the WebSocket — the `ws` library attaches to the same Node `Server`'s `upgrade` event. This avoids contorting Hono into WebSocket ownership while preserving one port and one server lifecycle.

### 9.1 Process and bind

`buildApp(version, options)` returns a Hono app. `http.ts` wraps it in a Node `http.Server`, calls `serve({ fetch: app.fetch, port, host })`, attaches the WebSocket bridge, and writes `.marshal/daemon.port` **after** the listener accepts. On SIGINT/SIGTERM, the server stops accepting, finishes in-flight requests, removes the port file, and exits.

The `buildApp` function is decoupled from the listener so tests can use it with Hono's in-process `app.request` (no port binding).

### 9.2 Route ownership

Every route calls into the task / worktree / run-log / spec-chat modules directly. There is no shelling out to `marshal ...` from inside an HTTP handler — the CLI and HTTP layers are two thin adapters over the same domain functions in `src/tasks/`, `src/worktree/`, and `src/daemon/`.

### 9.3 Validation

Request bodies are parsed by `readJsonObject(c, allowedKeys)` which rejects unknown fields with `400`. Body fields are asserted by `assertString` / `assertOneOf` with `422` on type/semantic errors. The `to` field of a transition is validated against `isTaskStatus`.

### 9.4 Task creation and the Ready endpoint

`POST /api/tasks` creates a `backlog` task. Body: `{ title, spec_markdown? }`. The slug is generated by `generateUniqueSlug` (same logic as `marshal task create`); the client never precomputes or reserves slugs.

`POST /api/tasks/:slug/ready` mirrors `marshal task ready`: optional `specMarkdown` override, then freeze and transition. The endpoint is the **only** way to create a worktree + commit a frozen spec atomically from the web board. If any freeze side effect fails, the API returns the error and the task is **not** marked Ready.

### 9.5 Transitions

`POST /api/tasks/:slug/transition` body `{ to }`. The handler delegates to `transitionTask`, which:

- Asserts the transition is in `VALID_TRANSITIONS` (`409 invalid_transition` otherwise).
- Resets `retry_count` and `last_failure` if the edge is an escape hatch.
- Updates `updated_at` and publishes `task.transitioned` on the bus.

The HTTP layer does not introduce new state edges. The server-side state machine is authoritative; the UI hides invalid actions but does not enforce them.

### 9.6 The freeze endpoint is distinct

Backlog-to-Ready is a **freeze action**, not a generic transition. It uses `POST /api/tasks/:slug/ready`, not `POST .../transition`. This separation is load-bearing: the freeze has filesystem + git side effects, and conflating it with a pure state move makes error recovery ambiguous.

---

## 10. WebSocket event bus

`src/daemon/ws.ts` (transport) + `src/daemon/bus.ts` (pub/sub boundary). The internal `EventBus` is a `Set<BusSubscriber>`; the WebSocket layer is one subscriber. Domain code (task store, run log, orchestrator, spec chat) calls `publish*` helpers after the durable write succeeds; it never knows about sockets.

### 10.1 Event envelope

```ts
{
  type: string,             // "task.created", "run.event", etc.
  payload: <type-specific>,
  timestamp: string         // ISO-8601, set by the daemon at publish time
}
```

See §0.3 for the full table.

### 10.2 Connected snapshot

On connection, the server sends a single `connected` event with `{ tasks: TaskPayload[] }` derived from `listTasks`. The client initializes from this snapshot; no race with a separate `GET /api/tasks` call. The client may still call `GET /api/tasks` for explicit refresh.

### 10.3 Ordering: broadcast only after durable write

`RunLog.insertEvent` writes the SQLite row **before** publishing `run.event`. Task store helpers write the row before publishing `task.*`. This means a client that receives a WebSocket event can immediately fetch the referenced task or run over HTTP and see consistent state. Errors from HTTP mutations are returned to the initiating client via the HTTP response, not broadcast as global events.

### 10.4 Reconnect model

No replay buffer, no sequence numbers, no resume tokens. A client that disconnects reconnects, receives a fresh `connected` snapshot, and continues from there. Run-event pagination is via HTTP (`GET /api/runs/:id/events?after_seq=...`).

### 10.5 Heartbeat

Server `ping` every 30s; client must respond with `pong`. The server tracks `lastPongAt` per connection and terminates a client silent for 90s. Dropped clients do not affect the loop or other clients.

---

## 11. Frontend (`web/`)

`web/src/`. Plain Vite + React (no meta-framework). Static SPA built into `web/dist/` and served by the daemon.

### 11.1 Stack and layout

```
web/
  index.html
  vite.config.ts             # dev proxy: /api/* and /ws → 127.0.0.1:7433
  src/
    main.tsx, App.tsx
    api/                     # client.ts (HTTP + WS), errors.ts
    hooks/                   # useBoard, useNow
    board/                   # Board, TaskCard, NewTaskModal, reducer, actions
    detail/                  # TaskDetail
    specchat/                # SpecChatPanel, marshalSpec parser, reducer
    diff/                    # DiffView, parseDiff
    toast/                   # ToastHost
    components/              # ConfirmDialog
    markdown.ts, time.ts, types.ts
```

The Vite dev server proxies `/api/*` and `/ws` to the daemon, so the client code uses same-origin relative URLs (`/api/tasks`, `/ws`) and the same code runs in dev and production.

### 11.2 Production serving

`buildApp` mounts the SPA in the Hono app:

| Request                       | Behavior                             |
| ----------------------------- | ------------------------------------ |
| `/api/*`                      | Hono API route.                      |
| `/ws`                         | WebSocket upgrade (handled by `ws`). |
| `/assets/*`                   | Static file from `web/dist/assets/`. |
| `/` and unknown non-API paths | `web/dist/index.html` SPA fallback.  |

If `web/dist/index.html` is missing, `GET /` returns a `404` with a clear "web bundle not built" message. The daemon does not crash if a developer has not run the frontend build.

### 11.3 State model

The board is a thin client over the HTTP + WS API. It keeps no durable state of its own:

- Initialize from `connected` snapshot (or `GET /api/tasks`).
- Apply WebSocket events as deltas via `board/reducer.ts`.
- On `task.transitioned` / `task.created` / `task.updated`, reconcile with the server payload.
- On WebSocket disconnect, reconnect and accept the new `connected` snapshot as truth.

Refreshing the page reconstructs the board from daemon APIs.

### 11.4 Styling

M1 is functional, not a design system. No component library, no CSS framework. The board renders the six columns (`backlog`, `ready`, `building`, `validating`, `review`, `done`) with cards showing title, slug, and time-in-state. Task detail renders spec markdown, status, retry count, and last failure.

---

## 12. Board interactions

`web/src/board/`. The web board is the primary control surface; the CLI is a peer client. The server-side state machine is always authoritative.

### 12.1 Action map

The UI shows only valid transitions for the current state. Hiding a button is a UX choice, not an enforcement — every transition goes through `transitionTask` and returns `409` for invalid edges.

| Status       | Primary UI actions                                    |
| ------------ | ----------------------------------------------------- |
| `backlog`    | Freeze to Ready (calls `POST /api/tasks/:slug/ready`) |
| `ready`      | (no manual action; daemon claims it)                  |
| `building`   | Re-queue to Ready, Send Back to Backlog               |
| `validating` | Send Back to Backlog                                  |
| `review`     | Approve & Merge, Send Back to Backlog                 |
| `done`       | (none)                                                |

### 12.2 Optimistic updates

For create and transition, the board applies the change optimistically and keeps the previous state until the HTTP response returns.

- On success: replace the optimistic state with the server-returned task; subsequent WebSocket events are treated as normal refreshes.
- On failure: roll back to the previous local state; show a toast with the server error envelope; do **not** invent a success-shaped WebSocket event.

If a WebSocket event arrives while a mutation is in flight, the HTTP response remains the final authority for that action. A follow-up `GET /api/tasks/:slug` can reconcile if needed.

### 12.3 Escape-hatch confirmation

The UI must confirm transitions that reset retry state or send work back:

- `building → ready`
- `building → backlog`
- `validating → backlog`
- `review → backlog`

The confirmation text makes the side effect explicit ("this will reset retry state" / "send back means the spec likely needs revision"). This mirrors the §2.2 distinction between automated and human-driven transitions.

### 12.4 Freeze is a distinct action

Backlog-to-Ready uses `POST /api/tasks/:slug/ready`, not the generic transition endpoint. The board calls the freeze endpoint and surfaces any freeze-side-effect error verbatim — it does not pretend the task is Ready when freeze failed.

---

## 13. Review and merge

`src/worktree/diff-merge.ts` + `src/daemon/http.ts` (routes).

### 13.1 Diff endpoint

`GET /api/tasks/:slug/diff`:

```json
{
  "diff": "diff --git ...",
  "stats": { "files": 2, "insertions": 10, "deletions": 3 }
}
```

The handler resolves the task's branch through `WorktreeManager` and runs `git` with argument arrays (never shell strings). The base is the auto-detected local trunk ref (§3.4). The `specs/` directory is excluded.

The web board renders the unified diff via `web/src/diff/DiffView.tsx`. Split-view is optional; the acceptance criterion is a readable, syntax-highlighted unified diff.

### 13.2 Local merge

`POST /api/tasks/:slug/merge` performs `git merge --no-ff <task-branch>` in the source checkout. Rationale:

- Preserves the `freeze:` and `build:` commit history as task provenance.
- Keeps task branches auditable after merge.
- Avoids rewriting builder history during the first human-reviewed flow.

Squash and rebase are deferred. Strict preconditions:

- The task exists.
- The task is in `review`.
- The worktree index has a branch for the task.
- The source checkout is on the configured base branch.
- The source checkout is clean enough to merge safely.

If any precondition fails, the API returns an error and does not modify task state. Merge conflicts return `409` and leave the task in `review` with the worktree preserved for inspection. The endpoint never auto-resolves conflicts.

On success:

1. Capture the resulting `HEAD` SHA.
2. `transitionTask(slug, "done")` (in the same operation; cleanup only happens after the merge commits cleanly).
3. `WorktreeManager.destroy(slug)` — remove the worktree directory and delete the task branch.
4. Return `{ merged: true, commitSha: "<sha>" }`.

If cleanup fails after a successful merge, the API surfaces the cleanup error and the task is **not** marked Done. The transition to Done is the last step, not the first.

### 13.3 Send Back

`review → backlog` is the Send Back action from the Review column. The transition is an escape hatch (resets retry state, preserves the worktree). The worker's commit history is left in the task branch for inspection / manual salvage. The worktree is cleaned up only on a successful merge (§13.2), not on Send Back.

### 13.4 PR creation (not yet implemented)

Slice 8 of the M1 plan (PR creation via `gh`) was **deferred**. There is no `POST /api/tasks/:slug/pr` endpoint, no `pr_url` column on `tasks`, and no GitHub integration in the current build. The `gh`-backed PR flow is the planned next step; until then, `review → done` is local-merge only.

---

## 14. Spec authoring chat

`src/daemon/spec-chat.ts` + `web/src/specchat/`. The grill-me chat surface for the Backlog phase.

### 14.1 Storage

`spec_messages` table (`src/db/schema.sql:44`). `role` is limited to `user` and `assistant` for M1. System prompts are generated, not stored as chat messages.

```
GET    /api/tasks/:slug/spec-messages   list chat messages for a Backlog task
POST   /api/tasks/:slug/spec-messages   store user message, invoke spec author agent, store response
POST   /api/tasks/:slug/spec            replace tasks.spec_markdown with proposed text
```

### 14.2 The proposed-spec block

The spec author agent is prompted to include a proposed replacement spec in a fenced `marshal-spec` block:

````
Here are the gaps I see...

```marshal-spec
# Goal
...
```
````

The web board enables Update Spec only when the latest assistant message contains a `marshal-spec` block. Clicking Update Spec sends the block content to `POST /api/tasks/:slug/spec`. This avoids fragile free-form extraction from ordinary assistant prose; the human still chooses whether to apply the draft.

### 14.3 Context window

`src/daemon/spec-chat.ts` composes the agent's context from:

- The current task title and status.
- The current `tasks.spec_markdown`.
- The most recent chat messages up to a configurable character budget (default 24,000 characters, newest to oldest).

If a chat exceeds the budget, older turns are omitted from the prompt but remain visible in the UI. M1 does not use summarization (summaries can silently distort requirements). The agent is told older history may be missing and should ask if context appears absent.

### 14.4 WebSocket broadcast

Each persisted message publishes `spec.message` over the bus (`{ taskSlug, message }`). This keeps multiple tabs in sync. HTTP remains the durable source for page load and reconnect.

### 14.5 Freeze from chat

Freeze is `POST /api/tasks/:slug/ready` (§9.4) — the same endpoint used by the CLI. The chat panel's Freeze button is a thin wrapper.

---

## 15. Onboarding and preflight

`src/setup/`. Non-interactive `marshal init`, read-only `marshal doctor`.

### 15.1 `marshal init` flow

1. **System prereqs** (`node`, `git`, `pnpm`).
   - `node` ≥ 18 (ES2022) — fail with install link.
   - `git` — fail (non-negotiable).
   - `pnpm` — warn; offer the install command in the message.
2. **acpx hard-gate** (`checkAcpx`).
   - `which acpx` (or `acpx.bin` from config) — fail with one install line.
   - `acpx --version` against the pinned range — warn on minor drift.
3. **Fast path** if `~/.marshal/config.json` already has `acpx` + `agents.builder` + `agents.validator`: print `✓ machine already configured` and skip to repo init.
4. **Config generation**: `generateConfig` writes `acpx.bin` / `acpx.version` / `agents.{builder,validator,specAuthor}` (with `AGENT_ID_DEFAULTS`) and `policy.maxRetries`. Existing user values are preserved.
5. **Repo init**: `initRepoState` (`.marshal/`) + `openDb` (`.marshal/state.db`).

`marshal init` is non-interactive. There is no `--yes`, no `--non-interactive`, no `MARSHAL_INIT_YES` env var. Running the command is the consent.

### 15.2 `marshal doctor`

Read-only diagnostic. Re-runs system prereqs + acpx check + per-agent session probe. Never mutates state. Exit code reflects pass/fail of each check.

### 15.3 Agent linking via the session probe

`checkAgent` (`src/setup/preflight.ts`) probes each configured agent via:

```
acpx <agent> sessions new   # spawn adapter, ACP initialize + session/new (zero tokens)
acpx <agent> sessions close # clean up
```

This proves adapter reachability, ACP capability negotiation, and the agent can be spawned — without consuming LLM tokens. It replaces the earlier `acpx <agent> exec 'hello'` handshake probe (which cost tokens) and the earlier `which <agent>` CLI-presence check (which gave false negatives for `npx`-fetched adapters).

Marshal **never** runs `which opencode` / `which pi` / `which claude` / `which codex`. The "is this agent linked" check goes through acpx, because acpx is the substrate that owns agent resolution.

Failure modes surfaced verbatim from the probe's stderr. The `AGENT_INSTALL_HINTS` table (§5.6) provides per-agent `acpxCommand` and `docs` URLs for the diagnostic line.

### 15.4 No provider auth env inspection

`marshal init` / `marshal doctor` **do not** check `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` or any other provider env var. The agent's own auth handshake (the session probe) is the authoritative "can this agent run" signal — it tests the actual code path the runtime uses, with no Marshal-side guessing about env var names. A user whose auth is configured via `~/.config/<agent>/auth.json` (not env) gets no false warning; a user whose key is set but expired gets no false reassurance.

### 15.5 acpx install is a hard-gate, not an in-process install

`marshal init` does not run `npm i -g acpx` itself. Reasons:

- Global npm prefix is often owned by root on VPS installs; the marshal process may not have sudo.
- Even a successful global install does not re-hash PATH inside the current process.
- The user is already in a terminal — telling them the one command is strictly more honest than a fake `✓` marker.

If acpx is missing, init prints the exact install command and exits non-zero. The user runs it in their own terminal and re-runs `marshal init`.

---

## 16. Security

### 16.1 Trust boundary

Per `docs/PROJECT.md` §8. The daemon's HTTP + WebSocket API is an RCE-as-a-service surface — it can spawn processes with file/exec permissions on request. Bind to `127.0.0.1` only by default. Any exposure beyond localhost requires an authenticated tunnel (SSH port-forward, Tailscale, or equivalent) or token-based auth on all HTTP/WebSocket endpoints. An unauthenticated listener reachable beyond localhost is never acceptable, regardless of perceived network-level safety.

`resolveDaemonBind` (`src/worktree/config.ts:131`) warns loudly if a non-loopback host is explicitly requested and proceeds only because the user asked for it.

### 16.2 Agent isolation

ACPX and the OpenClaw gateway do **not** sandbox the agent. The agent runs on the host with its own CLI file/exec permissions, and headless runs need a permissive profile (`--approve-all`) because there is no TTY to approve prompts. Running an approve-all agent bare on the host without isolation is unsafe in any scenario where the agent can reach paths beyond the task worktree.

For M0/M1 the isolation boundary is the **worktree** (`src/worktree/manager.ts`). Builder and validator both run inside the worktree directory; the worktree is the only filesystem scope either agent can mutate via the orchestrator's normal flow. Container / VM isolation is documented as the next step (`docs/PROJECT.md` §11) and is a precondition for any multi-tenant or auto-merge use.

### 16.3 Supply-chain posture

- ACPX is a pinned semver range (`>=0.12.0 <0.13.0`). A version mismatch logs a warning on daemon startup; it is not a hard fail because a minor bump is a normal semver transition against a stability-committed CLI.
- The `npm postinstall` hook for `acpx` fetches platform binaries; pin the version and review the hook before trusting it on a sensitive host.
- `better-sqlite3` is a native addon — installs require a C++ toolchain (python3, make, g++/clang) on the long tail. Prebuilt binaries cover common platforms.
- Provider API keys are the user's responsibility, configured per agent (ambient env vars, `~/.config/<agent>/`, or `ACPX_AUTH_*` entries). Marshal never reads or stores them.

### 16.4 Crash recovery

If the daemon process dies while a task is in `building` or `validating`, the policy on restart is conservative:

- The task is **not** auto-retried. The worktree is preserved, not garbage-collected.
- The in-flight `runs` row stays in `running` status (no `ended_at`); this is observable via `marshal task show` on a stuck task.
- The in-flight agent process is considered orphaned and is not reattached; the operator re-queues manually via `marshal task transition <slug> ready` (escape hatch).

SQLite WAL mode keeps the state database consistent across an unclean shutdown. Resume-from-checkpoint is a future improvement once the gate is proven reliable; the policy is stated explicitly rather than left undefined.

---

## Appendix A: Decision history

The historical ADRs and milestone slice documents are no longer in the working tree. They are preserved in `git log` and recoverable from any past commit. The decisions they capture are inlined into the sections above. The map below records the chain so a reader of `git log` can connect a section to its original rationale.

| Superseded by                                                            | Decisions captured in this doc (current section)              | Original rationale                                                       |
| ------------------------------------------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| ADR-001 (Node/npm, approved 2026-07-06)                                  | §1.1 (install), §1.2 (one daemon per repo), §11.2 (SPA serve) | The runtime + distribution + frontend decisions.                         |
| ADR-002 (worktree isolation, approved 2026-07-07)                        | §3 (worktree model)                                           | `.worktreeinclude`, setup script, location scheme.                       |
| ADR-003 (agent adapter + ACPX) — superseded by ADR-019, ADR-023, ADR-024 | §5 (agent layer)                                              | The `Agent` interface, NDJSON event mapping, session scope.              |
| ADR-004 (worktree base branch — `origin/<trunk>`, fetch not pull)        | §3.1 (base branch)                                            | Drift prevention across tasks.                                           |
| ADR-005 (spec freeze at Ready)                                           | §4 (spec lifecycle)                                           | Worktree lifecycle at Ready, spec file format, re-freeze policy.         |
| ADR-006 (builder run and run log)                                        | §6 (build run)                                                | Builder prompt template, `build:` commit, run log schema.                |
| ADR-007 (validator run and gate)                                         | §7 (validation run and gate)                                  | Single-worktree validator, gate sentinel, validator prompt.              |
| ADR-008 (retry cap and failure routing)                                  | §2.3, §8.2 (retry state)                                      | Bounded retries, escalation, builder errors don't consume.               |
| ADR-009 (escape-hatch transitions)                                       | §2.2 (escape hatches)                                         | Manual recovery transitions; retry-state reset.                          |
| ADR-010 (HTTP framework — Hono)                                          | §9 (HTTP API)                                                 | Hono + `@hono/node-server`; one Node server, WS on upgrade.              |
| ADR-011 (task CRUD API)                                                  | §9 (HTTP API)                                                 | Endpoint shapes, validation, error envelope, status codes.               |
| ADR-012 (WebSocket event bus)                                            | §10 (WebSocket event bus)                                     | Event envelope, snapshot, heartbeat, reconnect model.                    |
| ADR-013 (run history and logs API)                                       | §9 (HTTP API) + §0.4 (schema) + §6.4 (RunLog)                 | Pagination by `seq`, no replay in WS, durable via HTTP.                  |
| ADR-014 (frontend build and serve)                                       | §11 (frontend)                                                | Plain Vite React, dev proxy, `web/dist` serve, no design system.         |
| ADR-015 (board interactions)                                             | §12 (board interactions)                                      | Optimistic updates, escape-hatch confirm, freeze is distinct.            |
| ADR-016 (diff review and merge)                                          | §13 (review and merge)                                        | Unified diff, `merge --no-ff`, strict preconditions, Send Back.          |
| ADR-017 (GitHub PR creation) — **deferred**                              | §13.4 (placeholder)                                           | Planned `gh` flow, idempotent, polled, no embedded OAuth.                |
| ADR-018 (spec authoring chat)                                            | §14 (spec authoring chat)                                     | `spec_messages` table, `marshal-spec` block, bounded context.            |
| ADR-019 (coding agent agnostic)                                          | §5.6 (agent agnosticism)                                      | `AgentId = string`, no allowlist, no registry at runtime.                |
| ADR-020 (onboarding and setup) — superseded by ADR-022, ADR-024          | §15 (onboarding and preflight)                                | Preflight phases, fast path, config generation.                          |
| ADR-021 (CLI distribution)                                               | §1.1 (install)                                                | `npm i -g sataycat/marshal`, postinstall, native module.                 |
| ADR-022 (preflight revisions)                                            | §15.4 (no auth env inspection)                                | Handshake probe is authoritative; no provider env checking.              |
| ADR-023 (ACPX as sole substrate)                                         | §5.2, §5.6 (agent layer)                                      | No parallel direct-ACP adapter; version pin is a contract.               |
| ADR-024 (acpx hard-gate, agent linking)                                  | §15.3, §15.5 (preflight)                                      | Non-interactive init; zero-cost session probe; full acpx registry table. |
| M0-VERTICAL-SLICES.md                                                    | §1–§8 (everything M0)                                         | The slice history (all ✅-marked).                                       |
| M1-VERTICAL-SLICES.md                                                    | §9–§14, §11 (everything M1)                                   | The slice history (all ✅-marked except Slice 8, deferred).              |
