# M0 Vertical Slices

This doc breaks the M0 milestone from `PROJECT.md` into small, vertical slices that individual coding agents can pick up and finish. Each slice delivers observable behavior and builds on the previous ones.

## M0 Goal

> Daemon spawns opencode via the ACPX adapter on a Ready task, runs headless in a worktree to completion, hands the diff to pi as validator, and routes pass/fail through the state machine. No UI yet.

## Slicing Principles

1. **Vertical over horizontal.** Each slice is end-to-end, even if narrow.
2. **Observable behavior.** Every slice has a concrete acceptance test a human can run from the terminal.
3. **No premature UI.** M0 is headless; CLI commands and logs are the only interface.
4. **ADR-first for architecture changes.** Any decision that changes `PROJECT.md` or ADR-001 starts as a new ADR under `docs/`.
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

**Acceptance:**

```bash
pnpm install
pnpm run build
./bin/marshal --version       # prints version
./bin/marshal init            # creates .marshal/ and sqlite db in cwd
./bin/marshal task list       # empty list, no crash
```

**Files:** `package.json`, `tsconfig.json`, `src/cli.ts`, `src/daemon/config.ts`, `src/db/index.ts`, `src/db/schema.sql`.

---

## Slice 2 — Worktree Manager

**Goal:** Marshal can create and destroy isolated git worktrees for a task.

**Scope:**

- `WorktreeManager` class wrapping `git worktree add` / `remove`.
- Create a task branch named `marshal/task/<slug>-<shortid>` from `HEAD`.
- Return absolute path to worktree.
- Clean up worktree on demand.
- Handle idempotency and error cases (dirty repo, missing git, etc.).

**Acceptance:**

```bash
./bin/marshal worktree create --task hello-world
# creates ../marshal-hello-world-<id>/ worktree on a new branch
./bin/marshal worktree destroy --task hello-world
# worktree and branch are gone
```

**Files:** `src/worktree/manager.ts`, `src/worktree/manager.test.ts`.

---

## Slice 3 — Task State Machine

**Goal:** Tasks move through the M0 board states with valid transitions only.

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

**Acceptance:**

```bash
./bin/marshal task create --title "Add greeting" --slug add-greeting
./bin/marshal task transition add-greeting ready    # ok
./bin/marshal task transition add-greeting done     # error: invalid transition
./bin/marshal task show add-greeting                # status: ready
```

**Files:** `src/tasks/store.ts`, `src/tasks/state-machine.ts`, `src/tasks/commands.ts`.

---

## Slice 4 — Agent Adapter & ACPX Stub

**Goal:** Marshal can spawn an agent in a worktree and exchange a prompt/response through a stable internal interface, with ACPX behind it.

**Scope:**

- Define internal `Agent` interface: `spawn(cwd, agentId)`, `prompt(session, text)`, `close(session)`.
- ACPX adapter implementing the interface.
- For M0, support `opencode` and `pi` agent IDs mapped to ACPX sessions.
- Graceful handling of ACPX not being installed (clear error message).
- Capture stdout/stderr or typed events to a run log.

**Acceptance:**

```bash
# With ACPX + opencode installed
./bin/marshal agent run opencode --worktree /path --prompt "Say hello and exit"
# prints agent response and exits 0
```

**Files:** `src/agent/interface.ts`, `src/agent/acpx-adapter.ts`, `src/agent/run.ts`.

**ADR:** Update or extend ADR-001 if ACPX integration details differ from the current plan.

---

## Slice 5 — Builder Run (End-to-End)

**Goal:** A `ready` task is picked up by the orchestrator, a builder worktree is created, opencode runs against the frozen spec, and the task moves to `validating`.

**Scope:**

- Orchestrator loop: look for `ready` tasks, claim one, transition to `building`.
- Render the task spec into a prompt for the builder.
- Run opencode in the worktree with the prompt.
- Commit any changes the builder made to the task branch.
- Transition to `validating`.
- Run log stored in SQLite.

**Acceptance:**

```bash
./bin/marshal task create --title "Add README section" --slug readme-section \
  --spec "Add a 'Getting Started' section to README.md"
./bin/marshal task transition readme-section ready
./bin/marshal daemon run-once   # processes one ready task
./bin/marshal task show readme-section
# status: validating, branch has a new commit
```

**Files:** `src/orchestrator/builder-run.ts`, `src/orchestrator/index.ts`.

---

## Slice 6 — Validator Run & Gate

**Goal:** A `validating` task is checked by pi in a separate worktree; the task moves to `review` or back to `building` based on the result.

**Scope:**

- Create a second worktree from the same task branch (validator worktree).
- Run `pi` with a prompt that includes the diff and the spec.
- Parse validator output into `pass` / `fail`.
- On pass: transition `validating -> review`.
- On fail: transition `validating -> building` and append failure context to the run log.

**Acceptance:**

```bash
# After Slice 5 left a task in validating
./bin/marshal daemon run-once
./bin/marshal task show readme-section
# status: review (if pi passes) or building (if pi fails)
```

**Files:** `src/orchestrator/validator-run.ts`, `src/orchestrator/gate.ts`.

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

**Acceptance:**

```bash
# Create a task with an impossible spec
./bin/marshal task create --title "Break build" --slug break-build \
  --spec "Delete package.json and make tests pass"
./bin/marshal task transition break-build ready
# Run enough cycles to exhaust retries
for i in 1 2 3; do ./bin/marshal daemon run-once; done
./bin/marshal task show break-build
# status: review, retry_count: 2, last_failure_summary present
```

**Files:** `src/orchestrator/retry.ts`, `src/tasks/store.ts`.

---

## Slice 8 — Spec Freeze at Ready

**Goal:** When a task transitions to `ready`, its working spec is frozen as committed markdown in the task branch.

**Scope:**

- Render working spec to `specs/<NNNN>-<slug>.md` in the worktree.
- Commit the file to the task branch with message `freeze: <slug>`.
- The builder reads the spec from that file, not from SQLite.
- CLI: `task create` accepts `--spec` or `--spec-file`.

**Acceptance:**

```bash
./bin/marshal task create --title "Add docs" --slug add-docs \
  --spec "Document the CLI in README.md"
./bin/marshal task transition add-docs ready
# branch marshal/task/add-docs-<id> now contains specs/0001-add-docs.md
```

**Files:** `src/specs/freeze.ts`, `src/specs/renderer.ts`.

---

## Slice 9 — M0 CLI Polish & Integration Test

**Goal:** The full M0 loop can be driven from the CLI and has an automated smoke test.

**Scope:**

- Commands: `marshal task create`, `marshal task ready`, `marshal daemon start`, `marshal daemon run-once`, `marshal task show`.
- `marshal daemon start` polls for ready tasks (single-threaded, simple interval).
- Integration test using a temp git repo and stub agent responses.
- Update README with M0 usage.

**Acceptance:**

```bash
pnpm test
./bin/marshal --help
# Full manual demo: create -> ready -> daemon run-once -> review/done
```

**Files:** `tests/m0-smoke.test.ts`, `README.md`.

---

## Open Questions to ADR

Record decisions for these in new ADRs before they block implementation:

1. **Spec format.** What front-matter and sections must a frozen spec contain? (acceptance criteria, context, constraints)
2. **Agent prompt templates.** How are builder and validator prompts composed from the spec?
3. **Run log schema.** What events do we store and how do we query them?
4. **Configuration.** What lives in `~/.marshal/config.json` vs env vars vs CLI flags?
5. **Containerization revisit.** ADR-001 accepted bare-host isolation for M0. When do we revisit?

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
