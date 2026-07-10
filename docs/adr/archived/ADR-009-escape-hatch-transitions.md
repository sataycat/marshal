# ADR-009: Escape-Hatch State Transitions

## Status

Accepted — 2026-07-08

Implements `docs/M0-VERTICAL-SLICES.md` Slice 10 (Escape-Hatch State Transitions).

## Context

Slice 7 (ADR-008) closed the automated retry loop: a failing validator bounces `validating → building` up to a cap, then escalates `validating → review`. But that loop only covers *validator* failures, and it is automated.

Two stuck states have no CLI exit:

- **Failed build stuck in `building`.** ADR-006 Decision 7 leaves a failed builder run in `building` with no valid outgoing transition. The `VALID_TRANSITIONS` table in `src/tasks/state-machine.ts:3` only allows `building → validating`. A human who investigates the failed run and wants to re-queue or cancel must currently edit the SQLite row directly. ADR-006 Open Questions explicitly defer this to Slice 10: "Slice 10 will add manual recovery transitions (e.g. `building → ready`, `building → backlog`) so the human can re-queue or cancel without SQL surgery."
- **Bricked `validating` task.** `validateTask` can return `skipped` (no build commit to validate, or diff computation failed) without transitioning, leaving the task parked in `validating`. There is no manual transition back to authoring.

Slice 10 adds the manual escape hatches. It is deliberately separate from Slice 7's automated retry routing — escape hatches are human-driven recovery, not part of the daemon loop.

## Decisions

### 1. Three new manual transitions: `building → ready`, `building → backlog`, `validating → backlog`

```ts
// src/tasks/state-machine.ts
export const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  backlog: ["ready"],
  ready: ["building"],
  building: ["validating", "ready", "backlog"],      // +ready, +backlog
  validating: ["building", "review", "backlog"],      // +backlog
  review: ["done"],
  done: [],
};
```

- **`building → ready`** — re-queue a failed/stuck build. After human inspection, the orchestrator should pick the task up again. The worktree and frozen spec already exist from the freeze at Ready (ADR-005), so `runOnce`'s pre-flight check (frozen spec file exists) passes and the task is re-claimed `ready → building → …` normally. This is the primary escape hatch for ADR-006's stuck-in-building failure mode.
- **`building → backlog`** — send back to authoring. The human decided the spec itself needs rework, not just another build attempt.
- **`validating → backlog`** — send back to authoring from the validating state. Covers the case where a validator failure or a skipped validation (no build commit, diff failed) reveals a spec-level problem rather than an implementation problem.

### 2. `validating → ready` is deliberately NOT added

The slice scope names `building → ready`, `building → backlog`, and "possibly `validating → backlog`". A direct `validating → ready` (re-queue a new build from the validating state) is not in scope. A human who wants that effect today can do it in two steps:

- `validating → building` (existing) then `building → ready` (new), or
- `validating → backlog` (new) then `backlog → ready`.

Keeping the slice narrow avoids widening the automated loop's adjacency to `ready`. `validating → ready` is recorded as a deferred open question.

### 3. Escape hatches are manual-only; the orchestrator never drives them

`runOnce` only ever claims `ready`/`validating` tasks and transitions `ready → building`, `building → validating`, `validating → review`, and `validating → building` (automated retry). It never transitions a task to `ready` or `backlog`. The new transitions are reached only via `marshal task transition <slug> <state>` (or `transitionTask` in code). This keeps Slice 7's automated retry routing and Slice 10's manual recovery as separate concerns, matching the slice motivation: "manual recovery, not automated retry — Slice 7 owns automated retry routing."

### 4. Escape hatches reset retry state (`retry_count = 0`, `last_failure = NULL`)

ADR-008 Decision 3 explicitly states: "`retry_count` is reset to `0` so a future manual re-queue (Slice 10 escape hatches) starts with a fresh budget." A manual escape hatch is a deliberate human intervention — a fresh start — so the automated retry budget resets.

Implementation: inside `transitionTask`'s existing transaction (`src/tasks/store.ts:95`), when `(from, to)` is an escape hatch the same `UPDATE` that sets `status` also clears `retry_count` and `last_failure`. The set of escape-hatch edges is exported as `ESCAPE_HATCH_TRANSITIONS` from `src/tasks/state-machine.ts` so the store's reset policy stays colocated with the transition table.

Why inside `transitionTask` rather than the CLI command:

- **Atomic.** The reset and the state move share one SQLite transaction; there is never a half-reset state.
- **Consistent.** Every caller (CLI `transition`, programmatic `transitionTask`) gets the reset. The orchestrator's automated transitions are not escape hatches, so they do not trigger the reset — Slice 7's `incrementRetryCount` / `setLastFailure` / `clearRetryState` calls around `transitionTask` are unaffected.
- **Testable.** Store-level unit tests verify the reset directly without going through the CLI.

### 5. `task show` surfaces the last run's error context when stuck in `building` or `validating`

A task stuck in `building` from a failed build has a `runs` row with `status = 'error'`, but the task row's `last_failure` is null — ADR-008 Decision 4 says builder errors do not consume validation retries and therefore do not set `last_failure`. So the existing `last failure:` line (ADR-008 Decision 5) is empty for the most common stuck-building case, leaving the human without context.

`marshal task show <slug>` now queries the most recent run for the task — via a new `RunLog.getLastRunForTask(taskId)` helper — when `status` is `building` or `validating`, and prints:

```
last run: #<runId> <role> <agentId> <status>
run error: <error>
```

The `run error:` line appears only when the run has an error. The `last run:` line appears whenever the task is stuck and a run exists (a `running` status there is itself a useful signal of a crashed/hung run). This gives the human enough context to choose between re-queue (`building → ready`) and back-to-authoring (`building → backlog` / `validating → backlog`) without querying the run log by SQL.

The existing `last failure:` line (validator failure reason, ADR-008) remains; the two lines are complementary — `last failure` is the validator's gate reason, `run error` is the most recent run's error (builder or validator).

### 6. CLI `transition` already supports the new transitions; no new command

`marshal task transition <slug> <state>` calls `transitionTask`, which asserts against `VALID_TRANSITIONS`. Adding the three edges to the table automatically enables them in the CLI, with the retry-state reset from Decision 4 applied transparently. No new command or flag is introduced.

## Consequences

- Failed/stuck builds can be re-queued (`building → ready`) or sent back to authoring (`building → backlog`, `validating → backlog`) from the CLI — no SQL surgery.
- Escape hatches reset the retry budget, so a re-queued task gets a full automated retry budget again (per ADR-008).
- `task show` on a stuck task shows the failing run's error and role, not just the validator's `last_failure`.
- The state machine gains three new edges; the automated loop (Slices 5/6/7) is unchanged because `runOnce` never drives escape-hatch transitions.
- `transitionTask` gains transition-specific behavior (retry-state reset on escape hatches). This is the first non-status side effect inside `transitionTask`; it is scoped to the manually-defined escape-hatch set and documented here.

## Open questions (deferred)

- **`validating → ready` as a one-step manual re-queue.** Currently two steps (`validating → building → ready` or `validating → backlog → ready`). A direct edge would be convenient but widens the validating adjacency toward `ready`; deferred until there's a demonstrated need.
- **Worktree/branch cleanup on `→ backlog`.** The frozen worktree and `marshal/task/<slug>-<descriptor>` branch from ADR-005 persist when a task is sent back to `backlog`. Re-freezing after re-authoring reuses the existing worktree (`WorktreeManager.create` short-circuits). Whether to destroy the worktree on `→ backlog` (to discard the failed build's tree) is a later housekeeping decision.
- **Full run history in `task show`.** Decision 5 shows only the most recent run. A `task runs <slug>` subcommand listing the full attempt history is a future CLI addition.
- **Stale-run sweep.** A `running` run with no `ended_at` (crashed daemon) is now visible in `task show` via the `last run:` line, but not auto-recovered. A startup sweep that marks stale `running` runs as `error` is deferred (ADR-006 Open Questions).

## Related

- `docs/M0-VERTICAL-SLICES.md` Slice 10 — implementation scope.
- `docs/adr/ADR-006-builder-run-and-run-log.md` — Decision 7 (failed builds stuck in `building`); Open Questions deferring escape hatches to Slice 10.
- `docs/adr/ADR-008-retry-cap-and-failure-routing.md` — Decision 3 (retry state reset on manual re-queue); Decision 4 (builder errors do not set `last_failure`, motivating the `task show` run-error line); Decision 5 (the `last failure:` line this ADR complements).
- `docs/adr/ADR-005-spec-freeze-at-ready.md` — the worktree + frozen spec that make `building → ready` re-queue work without re-freezing.
- `src/tasks/state-machine.ts` — `VALID_TRANSITIONS` and `ESCAPE_HATCH_TRANSITIONS`.
- `src/tasks/store.ts` — `transitionTask` escape-hatch retry-state reset.
- `src/daemon/run-log.ts` — `getLastRunForTask`.
- `src/tasks/commands.ts` — `task show` stuck-run context.
