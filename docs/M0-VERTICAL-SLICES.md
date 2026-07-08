# M0 Vertical Slices

This doc breaks the M0 milestone from `PROJECT.md` into small, vertical slices that individual coding agents can pick up and finish. Each slice delivers observable behavior and builds on the previous ones.

## M0 Goal

> Daemon spawns opencode via the ACPX adapter on a Ready task, runs headless in a worktree to completion, hands the diff to pi as validator, and routes pass/fail through the state machine. No UI yet.

## Slicing Principles

1. **Vertical over horizontal.** Each slice is end-to-end, even if narrow.
2. **Observable behavior.** Every slice has a concrete acceptance test a human can run from the terminal.
3. **No premature UI.** M0 is headless; CLI commands and logs are the only interface.
4. **ADR-first for architecture changes.** Any decision that changes `PROJECT.md` or an existing ADR starts as a new ADR under `docs/adr/`.
5. **One task at a time.** Concurrency stays at 1 until the gate is proven.

## Dependency Map

```
Slice 1 ─┬─> Slice 2 ─┬─> Slice 4 ─┬─> Slice 5 ─┬─> Slice 6
         │            │            │            │
         └─> Slice 3 ─┘            └─> Slice 7 ─┘
```

---

## ✅ Slice 1 — Project Skeleton & CLI Bootstrap (COMPLETE)

**Goal:** You can install and run `marshal` from the repo. State directories exist and the database schema is in place.

**Scope:**

- TypeScript + Node project layout (`src/daemon`, `src/cli`, `src/agent`, `src/db`, `src/worktree`).
- Standard `pnpm` scripts wired for build, test, check.
- CLI entry point with `marshal --version` and `marshal init`.
- `~/.marshal/` global config and `.marshal/` per-repo state.
- SQLite schema for tasks: `id`, `slug`, `title`, `status`, `spec_markdown`, `created_at`, `updated_at`.
- Basic structured logging (`pino` or simple wrapper).

---

## ✅ Slice 2 — Worktree Manager (COMPLETE — base-branch policy amended by ADR-004)

**Goal:** Marshal can create and destroy isolated git worktrees for a task, following the isolation model in [`docs/adr/ADR-002-worktree-isolation.md`](adr/ADR-002-worktree-isolation.md).

**Scope:**

- `WorktreeManager` class wrapping `git worktree add` / `remove`.
- Centralized worktree location under `~/.marshal/worktrees/<repo-hash>/<slug>-<descriptor>/`.
- Create a task branch named `marshal/task/<slug>-<descriptor>` from `HEAD`, where `<descriptor>` is a memorable adjective-noun slug.
- Copy allowed gitignored files from the source checkout using `.worktreeinclude` (Conductor/Codex style).
- Run the optional setup script from `marshal.json` → `worktree.setup` after worktree creation.
- Return absolute path to worktree.
- Clean up worktree and branch on demand.
- Handle idempotency and error cases (dirty repo, missing git, etc.).

**ADR:** [`docs/adr/ADR-002-worktree-isolation.md`](adr/ADR-002-worktree-isolation.md).

---

## ✅ Slice 3 — Task State Machine (COMPLETE)

**Goal:** Tasks move through the M0 board states with valid transitions only.

**Completed in commit:** `dfe3694`

**Scope:**

- States: `backlog`, `ready`, `building`, `validating`, `review`, `done`.
- Valid transitions enforced in code:
  - `backlog -> ready`
  - `ready -> building`
  - `building -> validating`
  - `validating -> building` (retry)
  - `validating -> review`
  - `review -> done`
- CLI: `task create`, `task show`, `task transition <state>`.
- Persistence in SQLite.

---

## ✅ Slice 4 — Agent Adapter & ACPX Stub (COMPLETE)

**Goal:** Marshal can spawn an agent in a worktree and exchange a prompt/response through a stable internal interface, with ACPX behind it.

**Scope:**

- Define internal `Agent` interface: `spawn(cwd, agentId, opts?)`, `prompt(session, text, opts?)` returns `AsyncIterable<AgentEvent>`, `cancel(session)`, `close(session)`.
- ACPX adapter (`AcpxAgentAdapter`) implementing the interface by shelling out to the `acpx` CLI and parsing raw ACP JSON-RPC NDJSON.
- For M0, support `opencode` and `pi` agent IDs mapped to ACPX named sessions scoped by the worktree directory.
- Persistent ACPX sessions (`sessions ensure`/`-s`/`sessions close`) with stable names derived from the agent ID.
- Default permission mode `--approve-all --non-interactive-permissions fail` for headless runs; configurable per role via `SpawnOptions`.
- Configurable `acpx.bin` / `acpx.version` in `~/.marshal/config.json`, with a startup version check that warns on mismatch.
- Clear error when `acpx` is missing or an unknown agent ID is requested.
- Unit tests using a fake `acpx` shim on PATH.

**ADR:** [`docs/adr/ADR-003-agent-adapter-and-acpx.md`](adr/ADR-003-agent-adapter-and-acpx.md).

---

## Slice 5 — Builder Run (End-to-End)

**Goal:** A `ready` task is picked up by the orchestrator, a builder worktree is created, opencode runs against the frozen spec, and the task moves to `validating`.

**Scope:**

- Orchestrator loop: look for `ready` tasks, claim one, transition to `building`.
- Render the task spec into a prompt for the builder. (The frozen spec already lives at `specs/<NNNN>-<slug>.md` on the task branch from Slice 8; the builder reads it in its worktree per ADR-005.)
- Run opencode in the worktree with the prompt. (The worktree already exists from the freeze at Ready; `WorktreeManager.create(slug)` returns it. No new worktree is created at Building.)
- Commit any changes the builder made to the task branch.
- Transition to `validating`.
- Run log stored in SQLite.

---

## Slice 6 — Validator Run & Gate

**Goal:** A `validating` task is checked by pi in a separate worktree; the task moves to `review` or back to `building` based on the result.

**Scope:**

- Create a second worktree from the same task branch (validator worktree).
- Run `pi` with a prompt that includes the diff and the spec.
- Parse validator output into `pass` / `fail`.
- On pass: transition `validating -> review`.
- On fail: transition `validating -> building` and append failure context to the run log.

---

## Slice 7 — Retry Cap & Failure Routing

**Goal:** Failed validations retry a bounded number of times, then escalate to human review.

**Scope:**

- Track retry count on the task.
- Configurable cap (default `N = 2`).
- When validator fails:
  - If retries remaining: increment count, append failure context, move to `building`.
  - If cap reached: move to `review` with a failure summary.
- CLI: `task show` displays retry count and last failure.

---

## ✅ Slice 8 — Spec Freeze at Ready (COMPLETE)

**ADR:** [`docs/adr/ADR-005-spec-freeze-at-ready.md`](adr/ADR-005-spec-freeze-at-ready.md). Settles the worktree lifecycle at the Ready transition (Option A: the freeze creates the worktree + branch), the spec file format, the `--spec-file` / `task ready` / `task freeze` CLI surface, and re-freeze semantics.

**Goal:** When a task transitions to `ready`, its working spec is frozen as committed markdown in the task branch.

**Scope:**

- Render working spec to `specs/<NNNN>-<slug>.md` in the worktree.
- Commit the file to the task branch with message `freeze: <slug>`.
- The builder reads the spec from that file, not from SQLite.
- CLI: `task create` accepts `--spec` or `--spec-file`.

---

## Slice 9 — M0 CLI Polish & Integration Test

**Goal:** The full M0 loop can be driven from the CLI and has an automated smoke test.

**Scope:**

- Commands: `marshal task create`, `marshal task ready`, `marshal daemon start`, `marshal daemon run-once`, `marshal task show`.
- `marshal daemon start` polls for ready tasks (single-threaded, simple interval).
- Integration test using a temp git repo and stub agent responses.
- Update README with M0 usage.

---

## Open Questions to ADR

Record decisions for these in new ADRs before they block implementation:

1. **Spec format.** What front-matter and sections must a frozen spec contain? (acceptance criteria, context, constraints)
2. **Agent prompt templates.** How are builder and validator prompts composed from the spec?
3. **Run log schema.** What events do we store and how do we query them?
4. **Configuration.** What lives in `~/.marshal/config.json` vs env vars vs CLI flags?
5. **Containerization revisit.** [`docs/adr/ADR-001-node-backend-and-embedded-react.md`](adr/ADR-001-node-backend-and-embedded-react.md) accepted bare-host isolation for M0. When do we revisit?

## Suggested Order for Agents

1. Slice 1 (skeleton)
2. Slice 2 (worktree) and Slice 3 (state machine) — can be parallel
3. Slice 4 (agent adapter)
4. Slice 8 (spec freeze) — can be done once state machine exists
5. Slice 5 (builder run)
6. Slice 6 (validator run)
7. Slice 7 (retry routing)
8. Slice 9 (polish + integration test)

After each slice: `pnpm run check && pnpm test`.
