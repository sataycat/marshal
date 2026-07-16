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

Marshal is agent-agnostic. The `Agent` interface (spawn, prompt, cancel, close) is the only abstraction the orchestrator depends on. `SdkAcpAgentAdapter`, built on `@agentclientprotocol/sdk`, is the sole runtime implementation.

- **Role configuration**: every role uses a structured `{ id, command, args, env? }` value. Commands are spawned directly without a shell. Legacy string values are invalid and `marshal init` replaces them with generated direct defaults.
- **`AgentId`** remains a plain string inside the orchestrator. Runtime-specific command details stop at the adapter factory.
- **Session scope**: builder and validator share the task worktree (`cwd`) but have distinct session names. Direct runs currently use one process and one ACP session per run; restart-resumable direct sessions are not claimed.
- **Events**: the adapter maps ACP `session/update` notifications to the stable `AgentEvent` union (text, thinking, tool, permission, log, done, error). Unknown updates pass through as log events.
- **Permission mode**: headless roles use explicit Marshal policy. The adapter selects allow/reject options by ACP permission-option kind; it never assumes the first option is safe.
- **Diagnostics**: `marshal doctor` probes roles with ACP initialize + `session/new` without sending a model prompt.

Misconfiguration surfaces at first role resolution or `spawn`, not daemon boot. Invalid role shapes, missing executables, and ACP protocol failures become actionable errors.

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

ACP does **not** sandbox the agent. The agent runs on the host with its own permissions. Isolation (container, VM) is the operator's responsibility. The worktree is the current filesystem scope boundary — the agent could escape it.

Provider API keys are the user's responsibility. Marshal never reads or stores them.

### Crash recovery

If the daemon dies mid-build or mid-validate, the task is **not** auto-retried. The worktree is preserved, the in-flight run stays in `running` status, and the operator re-queues manually via escape hatches. Conservative by design.

---

## 9. Onboarding

`marshal init` is **non-interactive** — running it is the consent. Flow:

1. Check system prereqs (node, git, pnpm).
2. Write structured direct ACP role defaults. Marshal never installs agent runtimes itself.
3. Write `~/.marshal/config.json` with agent role defaults if not already configured.
4. Create `.marshal/` and `.marshal/state.db` for the current repo.

`marshal doctor` is the read-only diagnostic. It re-runs prereq checks and probes each role with direct ACP initialize + `session/new`. Marshal never checks provider env vars (e.g. `OPENAI_API_KEY`) — the session probe is the authoritative "can this agent run" signal.

---

## 10. Frontend

React 18 SPA in `web/`, built by Vite to `web/dist/` and served by the daemon (the Vite dev server proxies `/api/*` and `/ws`). Stack: **React 18 + Vite + Tailwind v4 (`@tailwindcss/vite`) + shadcn/Base UI primitives + wouter + `@uiw/react-codemirror` + `marked`**, light-mode only.

### Routing

History-mode routing via **wouter** (`web/src/routes/routes.ts` centralizes paths, nav items, and `lazy()` chunk loaders). `App.tsx` wraps a `Router` + `Switch` over `lazy()` route components; `/` redirects to `/board`; `BoardProvider` sits at app level to share the WebSocket bus. The daemon's existing SPA fallback (`src/daemon/http.ts` `spaNotFound`) serves deep links, so refreshing `/chat/<threadId>` boots the bundle and resolves the route client-side. `PrefetchNavLink` triggers a route chunk on `mouseenter`/`focus`.

### Layout

`<AppShell>` owns the header + main slot (and a `@container` on the main slot so the chat pane knows its own width). At `md:` (768px) the board + detail sit side-by-side; below `md:` they stack and a mobile bottom-nav (`Tabs` at `md:hidden`) toggles Board / Chat / Detail. Tailwind v4 breakpoints are overridden in `@theme` (`sm = 480px`, `md = 768px`) so the named scale matches the design intent. `styles.css` is gone — `web/src/index.css` imports Tailwind + the `@theme` tokens only.

### Board surface

The board is a thin client: initializes from the `connected` WebSocket snapshot, applies event deltas, and reconciles on reconnect. No durable client-side state. The board renders six columns matching the state machine, with task cards showing title, slug, and time-in-state. Task detail includes spec, diff view, run log, and spec-authoring chat.

Optimistic updates on mutations; rollback on server error. The server-side state machine is always authoritative — the UI hides invalid actions but does not enforce them.

### Code rendering & editing

One engine — `@uiw/react-codemirror` (CodeMirror 6) — serves both read-only highlighting and editable code. `web/src/codemirror/CodeBlock.tsx` is the public surface (`editable: boolean` prop); `languages.ts` maps fence strings (`ts`, `tsx`, `js`, `jsx`, `md`, `json`, `css`, `py`, `sql`, `diff`, …) to per-language extension imports, falling back to plain text. `MarkdownWithCode.tsx` integrates it with `marked`: prose is rendered with `marked`, then a hydration pass replaces `<pre><code class="language-…">` stubs with mounted `<CodeBlock>` instances. The first block of a session briefly renders as plain monospace, then hydrates; the CodeMirror module is cached for the session after. CodeMirror is wired into `TaskDetail` (spec), `SpecChatPanel` (chat messages), and `DiffView` (hunk bodies as `lang="diff"`). The spec-block "Edit this block" affordance flips a block to `editable` locally (no PATCH in Phase 1).

### Performance

Code-split aggressively: route-level `lazy()` chunks + point-of-use lazy loads for `marked` (`web/src/markdown.ts` `renderMarkdown`/`renderProse` dynamic-import on first call) and the CodeMirror engine (lazy on first `<CodeBlock>` mount, never in the initial chunk). **`size-limit`** is the per-PR gate: `pnpm run size` checks per-chunk gzipped budgets (`web/.size-limit.json`), wired into `pnpm run build:web` so a budget breach fails the build. **`rollup-plugin-visualizer`** behind `ANALYZE=1` (`pnpm run analyze`) emits `web/dist/stats.html` for manual triage; it is not a production-graph dep. Lighthouse (P≥90 / BP≥95) is a release-cadence gate, not per-PR. A11y is inherited from Base UI; not gated or tracked.

### File map (frontend)

- `web/src/App.tsx`, `web/src/shell/AppShell.tsx` — app shell + routing root.
- `web/src/routes/routes.ts` — paths, nav, chunk loaders.
- `web/src/board/*` — board surface (reducer, actions, `TaskCard`, `BoardContext` WebSocket bus).
- `web/src/detail/TaskDetail.tsx`, `web/src/diff/DiffView.tsx`, `web/src/specchat/SpecChatPanel.tsx` — task surfaces (all consume `MarkdownWithCode`).
- `web/src/codemirror/{CodeBlock,languages,MarkdownWithCode}.tsx` — CodeMirror integration.
- `web/src/markdown.ts` — `renderMarkdown` / `renderProse` (lazy `marked`).
- `web/src/components/ui/*` — shadcn/Base UI primitives (`Sheet`, `Dialog`, `Button`, `Tooltip`, `Tabs`, …) + the `cn()` helper.
- `web/vite.config.ts`, `web/.size-limit.json`, `web/src/index.css` — build/theming config.
