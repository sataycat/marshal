# M1 Vertical Slices

This doc breaks the M1 milestone from `PROJECT.md` into small, vertical slices. Each slice delivers observable behavior and builds on the previous ones.

## M1 Goal

> Control plane. HTTP + WebSocket API, Kanban board (web), task lifecycle visible and driveable from the browser, PR creation and merge flow.

M1 transforms Marshal from a CLI-only tool into a web-controlled daemon. The human drives the board; the machine drives the loop. The CLI remains a first-class peer client — nothing added in M1 removes CLI access.

## Slicing Principles

Same as M0:

1. **Vertical over horizontal.** Each slice is end-to-end, even if narrow.
2. **Observable behavior.** Every slice has a concrete acceptance test.
3. **No premature polish.** Ship function over form; styling is a follow-up.
4. **ADR-first for architecture changes.** Any decision that changes `PROJECT.md` or an existing ADR starts as a new ADR under `docs/adr/`.
5. **One task at a time.** Concurrency stays at 1.

## Dependency Map

```
Slice 1 ─┬─> Slice 2 ─┬─> Slice 4 ─> Slice 5 ─> Slice 8
         │            │
         └─> Slice 3 ─┘─> Slice 6 ─> Slice 7
                                         │
                           Slice 9 ──────┘
```

---

## Slice 1 — HTTP API Server Skeleton ✅

**Goal:** The daemon process serves an HTTP API on localhost. Existing CLI commands work unchanged; a new `marshal daemon start` now also binds a port.

**Scope:**

- Add an HTTP server to the daemon process (Hono or Fastify — lean toward Hono for its lightweight footprint; decide in ADR).
- Bind to `127.0.0.1` on a configurable port (default `7433`, configurable via `~/.marshal/config.json` → `daemon.port` or `--port` flag).
- Write the bound port to `.marshal/daemon.port` so clients can discover it (per PROJECT.md §3.1 process model).
- Health endpoint: `GET /api/health` → `{ status: "ok", version: "0.0.1" }`.
- Graceful shutdown: on SIGINT/SIGTERM, stop accepting connections, finish in-flight requests, then exit.
- `daemon.port` file is removed on clean shutdown.
- Security: bind localhost only. Log a warning if the user attempts to override with `0.0.0.0` (no auth layer yet).
- Existing orchestrator poll loop (`startDaemon`) runs alongside the HTTP server in the same process.

**Acceptance test:** `marshal daemon start`, then `curl http://127.0.0.1:7433/api/health` returns 200.

**ADR:** Decide HTTP framework (Hono vs Fastify vs raw `node:http`). Document in `docs/adr/ADR-010-http-framework.md`.

---

## Slice 2 — Task CRUD API ✅

**Goal:** Tasks can be listed, created, inspected, and transitioned via HTTP, matching the existing CLI surface.

**Scope:**

- `GET /api/tasks` → list all tasks (id, slug, title, status, retry_count, created_at, updated_at).
- `GET /api/tasks/:slug` → single task with full detail (includes spec_markdown, last_failure).
- `POST /api/tasks` → create a task. Body: `{ title, spec_markdown? }`. Returns the created task with generated slug.
- `POST /api/tasks/:slug/transition` → body: `{ to }`. Enforces state machine. Returns updated task.
- `POST /api/tasks/:slug/ready` → freeze spec + transition to ready (mirrors `marshal task ready`). Body: `{ specMarkdown? }` (optional override of stored spec).
- Error responses use a consistent envelope: `{ error: string, code?: string }`.
- Input validation: reject unknown fields, validate `to` is a known status, etc.
- Slug auto-generation uses the same logic as the CLI (`tasks/commands.ts`).

**Acceptance test:** Create a task via curl, list it, freeze it, observe worktree created.

**ADR:** Document task CRUD API shape, validation, and CLI/domain reuse in `docs/adr/ADR-011-task-crud-api.md`.

---

## Slice 3 — WebSocket Event Bus

**Goal:** Clients receive real-time updates when task state changes or run events occur, without polling.

**Scope:**

- WebSocket endpoint at `/ws`.
- On connect, client receives a `connected` event with the current task list snapshot.
- Server broadcasts events on:
  - Task created / transitioned / updated.
  - Run started / event logged / run finished.
  - Daemon idle (no ready tasks) / daemon cycle complete.
- Event shape: `{ type: string, payload: object, timestamp: string }`.
- Multiple concurrent WebSocket clients supported.
- Heartbeat ping/pong every 30s; server drops silent clients after 90s.
- No authentication for M1 (localhost-only per Slice 1 security constraint).

**Acceptance test:** Open a WebSocket to `ws://127.0.0.1:7433/ws`, create a task via the HTTP API, observe `task.created` event on the socket.

**ADR:** Document WebSocket event bus shape, delivery semantics, and heartbeat policy in `docs/adr/ADR-012-websocket-event-bus.md`.

---

## Slice 4 — Run History & Logs API

**Goal:** Run history and per-run event streams are queryable via HTTP for the web board to display build/validation output.

**Scope:**

- `GET /api/tasks/:slug/runs` → list runs for a task (id, role, agent_id, status, started_at, ended_at, commit_sha, error).
- `GET /api/runs/:id` → single run detail.
- `GET /api/runs/:id/events` → paginated run events (seq, type, payload, created_at). Query params: `after_seq`, `limit` (default 100).
- During an active run, the WebSocket broadcasts `run.event` messages in real time (from Slice 3 bus).
- Existing `RunLog` class emits to the bus when writing events.

**Acceptance test:** Trigger a build via `POST /api/tasks/:slug/transition { to: "building" }` (or `daemon run-once`), then `GET /api/runs/:id/events` returns the builder's streamed output.

---

## Slice 5 — Static SPA Shell & Board View

**Goal:** The daemon serves a React SPA that displays the Kanban board with live task state.

**Scope:**

- React SPA scaffolded (Vite for dev, pre-built bundle served by the daemon in production).
- The daemon serves `GET /` → `index.html` (and static assets) from a `web/dist/` directory.
- Kanban columns: Backlog, Ready, Building, Validating, Review, Done.
- Each card shows: title, slug, time-in-state.
- Cards update in real time via WebSocket (Slice 3).
- Click a card → detail panel showing spec markdown (rendered), status, retry count, last failure.
- No drag-and-drop yet (transitions are button-driven in Slice 6).
- Responsive enough for a laptop browser; no mobile optimization.

**ADR:** Decide on React meta-framework or plain Vite React. Document build/serve strategy in `docs/adr/ADR-013-frontend-build-and-serve.md`.

**Acceptance test:** `marshal daemon start`, open `http://127.0.0.1:7433/` in a browser, see the board with any existing tasks.

---

## Slice 6 — Board Interactions (Transitions & Create)

**Goal:** The web board is interactive — users can create tasks, freeze specs, and trigger transitions from the UI.

**Scope:**

- "New Task" button → modal with title + spec markdown editor (plain textarea for M1).
- Task detail panel → transition buttons based on current state (only valid transitions shown).
  - Backlog → Ready (freezes spec).
  - Review → Done.
  - Escape hatches: Building → Ready, Building → Backlog, Validating → Backlog.
- Optimistic UI updates with rollback on API error.
- Toast notifications for errors (e.g., invalid transition, spec empty).
- Confirm dialog for escape-hatch transitions ("This will reset retry state. Continue?").

**Acceptance test:** Create a task from the board, freeze it, observe it move to Ready, then watch it progress through Building → Validating → Review as the daemon runs.

---

## Slice 7 — Diff Review Panel

**Goal:** The Review column is actionable — the human can inspect the builder's diff and decide to merge or send back.

**Scope:**

- Task detail in Review state shows a diff viewer (split or unified, toggle).
- Diff sourced from `git diff <trunk>...<task-branch>` via a new API endpoint: `GET /api/tasks/:slug/diff` → unified diff text.
- Syntax-highlighted diff rendering in the browser (use a lightweight lib like `diff2html` or `react-diff-view`).
- "Approve & Merge" button → merges the task branch into the base branch, transitions to Done, cleans up worktree.
- "Send Back" button → transitions to Backlog (escape hatch), preserves worktree for inspection.
- New API endpoints:
  - `GET /api/tasks/:slug/diff` → `{ diff: string, stats: { files: number, insertions: number, deletions: number } }`.
  - `POST /api/tasks/:slug/merge` → performs the merge, returns `{ merged: true, commitSha: string }`.

**Acceptance test:** A task reaches Review, open the board, view the diff, click "Approve & Merge", task moves to Done, branch is merged into trunk.

---

## Slice 8 — PR Creation (GitHub)

**Goal:** Instead of local-only merge, the human can push the task branch and open a GitHub PR from the board.

**Scope:**

- New API endpoint: `POST /api/tasks/:slug/pr` → pushes the task branch to origin, creates a PR via `gh pr create`, returns the PR URL.
- PR title defaults to the task title; body contains the frozen spec markdown.
- Task detail in Review shows the PR link once created.
- Configuration: `~/.marshal/config.json` → `github.remote` (default `origin`), `github.baseBranch` (default: auto-detect trunk).
- Requires `gh` CLI authenticated on the host (no embedded OAuth for M1).
- The "Approve & Merge" flow from Slice 7 still works for local-only usage; PR creation is an alternative path.
- Task moves to Done when the PR is merged (polled or webhook — for M1, poll on `GET /api/tasks/:slug` checks `gh pr view --json state`).

**Acceptance test:** Task in Review, click "Create PR", PR appears on GitHub with the correct diff and spec in the body.

---

## Slice 9 — Spec Authoring Chat (Grill-Me)

**Goal:** The Backlog column has a chat-based spec authoring surface where a human and an agent iterate on the spec before freezing.

**Scope:**

- Task detail in Backlog/Spec state shows a chat panel alongside the evolving spec draft.
- The human types messages; an agent responds with suggestions, questions, and spec refinements.
- Agent used for spec authoring is configurable (`~/.marshal/config.json` → `agents.specAuthor`, default same as builder).
- Chat history stored in a new `spec_messages` table: `id, task_id, role (user|assistant), content, created_at`.
- The agent sees the current spec draft + full chat history as context on each turn.
- "Update Spec" button → applies the agent's latest suggested spec text to `tasks.spec_markdown`.
- "Freeze" button → equivalent to `task ready` (transitions to Ready, commits spec, creates worktree).
- WebSocket broadcasts chat messages in real time for multi-tab usage.
- The agent is invoked via the same `Agent` interface (Slice 4 from M0) — spec authoring is just another prompt/response cycle.

**Acceptance test:** Open a Backlog task in the board, chat with the agent about the spec, click "Update Spec" to capture the refined version, click "Freeze", task moves to Ready with the authored spec committed.

**ADR:** Decide spec-authoring agent prompt template and context window strategy. Document in `docs/adr/ADR-014-spec-authoring-chat.md`.

---

## Open Questions to ADR

Record decisions for these in new ADRs before they block implementation:

1. **HTTP framework choice.** Hono vs Fastify vs raw node:http. (Slice 1)
2. **Frontend build/serve strategy.** Vite dev proxy vs pre-built bundle served by daemon. Monorepo structure for web/. (Slice 5)
3. **Spec authoring prompt design.** How much context to feed the agent, how to handle long chats exceeding context window. (Slice 9)
4. **Auth for non-localhost.** When the daemon is exposed via tunnel, what auth mechanism? Token-based? (Deferred past M1 but worth recording.)
5. **Merge strategy.** Squash vs merge commit vs rebase for task branches. (Slice 7)

## Suggested Order for Agents

1. Slice 1 (HTTP skeleton) — foundational, everything depends on it.
2. Slice 2 (Task CRUD API) and Slice 3 (WebSocket bus) — can be parallel.
3. Slice 4 (Run history API) — depends on Slice 2.
4. Slice 5 (SPA shell) — depends on Slices 2 + 3.
5. Slice 6 (Board interactions) — depends on Slice 5.
6. Slice 7 (Diff review) — depends on Slice 6.
7. Slice 8 (PR creation) — depends on Slice 5.
8. Slice 9 (Spec authoring chat) — depends on Slice 6; can parallel with 7/8.

After each slice: `pnpm run check && pnpm test`.

## Non-Goals for M1

- Mobile-responsive design.
- Multi-user auth or RBAC.
- Inline code comments on diffs (M2 scope alongside the first-class gate).
- TUI client (M4).
- Auto-merge (requires M2 gate maturity).
- Spend ceiling tracking UI (M2; schema addition may land in M1 if convenient).
