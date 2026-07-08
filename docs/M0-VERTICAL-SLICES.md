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
Slice 1 ─┬─> Slice 2 ─┬─> Slice 4 ─┬─> Slice 5 ─┬─> Slice 6 ─┬─> Slice 9
         │            │            │            │            │
         └─> Slice 3 ─┘            └─> Slice 7 ─┘            │
                    │                                         │
                    └─> Slice 8 ──────────────────────────────┘
                                                              │
                    Slice 10 (escape hatches) ─────────────────┘
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

## ✅ Slice 5 — Builder Run (End-to-End) (COMPLETE)

**Completed in commit:** `627552a` — `feat: implement Slice 5 — Builder run, run log, and ADR-006`

**Goal:** A `ready` task is picked up by the orchestrator, a builder worktree is created, opencode runs against the frozen spec, and the task moves to `validating`.

**Scope:**

- Orchestrator loop: look for `ready` tasks, claim one, transition to `building`.
- Render the task spec into a prompt for the builder. (The frozen spec already lives at `specs/<NNNN>-<slug>.md` on the task branch from Slice 8; the builder reads it in its worktree per ADR-005.)
- Run opencode in the worktree with the prompt. (The worktree already exists from the freeze at Ready; `WorktreeManager.create(slug)` returns it. No new worktree is created at Building.)
- Commit any changes the builder made to the task branch.
- Transition to `validating`.
- Run log stored in SQLite.

**ADR:** [`docs/adr/ADR-006-builder-run-and-run-log.md`](adr/ADR-006-builder-run-and-run-log.md) settles the builder prompt template (inlines the spec from SQLite), the `runOnce` / `buildTask` split, the `runs` / `run_events` schema, the `build:` commit, and leaves the task in `building` on failure (retry routing is Slice 7).

---

## ✅ Slice 6 — Validator Run & Gate (COMPLETE)

**Completed in commit:** `feat: implement Slice 6 — validator run & gate` (pending)

**Goal:** A `validating` task is checked by the configured validator harness; the task moves to `review` or back to `building` based on the result. The slice is harness-agnostic — which agent (e.g. `opencode-go`, `pi`) acts as validator is resolved from `~/.marshal/config.json` at runtime, set by the user during onboarding when they wire up their harness API keys. M0 development focuses on `opencode-go` and `pi` as the first supported harnesses via the ACPX adapter (Slice 4), but no slice-specific code should hard-code either one.

**Scope:**

- Resolve the validator agent ID from `~/.marshal/config.json` (`agents.validator`, defaulting to `pi`) at run time, rather than hard-coding a harness in the orchestrator. A `resolveAgentId(role)` helper sits in `src/worktree/config.ts`; the same shape exists for `builder` (not yet read by the orchestrator, kept symmetric).
- Reuse the builder's worktree for the validator (no second worktree). The builder's `--allow-empty` commit (ADR-006 Decision 5) leaves a clean tree; the validator's role is read + run tests, not modify the tree. Decorrelation comes from the different agent, not a different fs.
- Run the configured validator harness via the ACPX `Agent` adapter (Slice 4) with a prompt that includes the diff (truncated to 2000 lines) and the spec. Builder and validator may use the same harness or different ones; the slice works for either case.
- Parse validator output into `pass` / `fail` via a `MARSHAL_GATE: pass` / `MARSHAL_GATE: fail <reason>` sentinel scanned in the validator's text events. A missing sentinel is treated conservatively as fail.
- On pass: transition `validating -> review`.
- On fail (sentinel, missing sentinel, validator error, spawn failure): transition `validating -> building`. Failure reason stored in `runs.error`. Retry cap and escalation to human review on cap is Slice 7.

**ADR:** [`docs/adr/ADR-007-validator-run-and-gate.md`](adr/ADR-007-validator-run-and-gate.md) settles the validator agent config schema, the sentinel-based pass/fail signal, the single-`runOnce` dispatch over `ready` + `validating`, the spec + truncated diff prompt composition, and the always-bounce-on-non-pass routing.

---

## ✅ Slice 7 — Retry Cap & Failure Routing (COMPLETE)

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

## ✅ Slice 10 — Escape-Hatch State Transitions (COMPLETE)

**Goal:** Failed or stuck tasks can be manually re-queued or cancelled without SQL surgery.

**Scope:**

- Add `building → ready` transition to the state machine for re-queuing a failed build after human inspection.
- Add `building → backlog` (and possibly `validating → backlog`) for sending a task back to authoring.
- CLI: `marshal task transition <slug> <state>` supports the new transitions.
- `task show` displays the last run's error context when a task is stuck in `building` or `validating`.
- ADR: records the escape-hatch transitions and their intended use (manual recovery, not automated retry — Slice 7 owns automated retry routing).

**Motivation:** ADR-006 Decision 7 leaves failed builds stuck in `building` with no valid transition out. A human who investigates and wants to re-queue must currently use SQL surgery. Slice 10 adds the manual escape hatches; Slice 7's automated retry routing is separate and builds on top.

**ADR:** [`docs/adr/ADR-009-escape-hatch-transitions.md`](adr/ADR-009-escape-hatch-transitions.md) settles the three new edges (`building → ready`, `building → backlog`, `validating → backlog`), the manual-only policy, the retry-state reset on escape hatches (per ADR-008), and the `task show` last-run error context.

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
5. ~~Slice 5 (builder run)~~ ✅
6. ~~Slice 6 (validator run)~~ ✅
7. Slice 7 (retry routing)
8. Slice 9 (polish + integration test)
9. Slice 10 (escape hatches) — can be done any time after Slice 3; does not block other slices

After each slice: `pnpm run check && pnpm test`.
