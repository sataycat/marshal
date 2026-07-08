# ADR-008: Retry Cap and Failure Routing

## Status

Accepted — 2026-07-08

Implements `docs/M0-VERTICAL-SLICES.md` Slice 7 (Retry Cap & Failure Routing).

## Context

Slice 6 closed the M0 validation loop: a `validating` task is checked by the configured validator, and on any non-pass outcome the task bounces back to `building` to retry. Slice 6 intentionally left the loop unbounded — ADR-007 Decision 7 states that "Slice 7's retry cap will bound the resulting bounce loop."

Without a cap, a task with a consistently failing validator would oscillate forever. Slice 7 adds:

- A bounded number of retries.
- Escalation to human review when the cap is exceeded.
- Visibility into retry count and the last failure reason from the CLI.

## Decisions

### 1. Track retry state on the task row

The `tasks` table gains two columns:

```sql
retry_count INTEGER NOT NULL DEFAULT 0,
last_failure TEXT
```

- `retry_count` counts how many times the validator has already failed for this task and bounced it back to `building`.
- `last_failure` stores the most recent validator failure reason (the `MARSHAL_GATE: fail <reason>` reason, or the fallback reason when no sentinel is emitted / the validator errors / spawn fails).

Why on the task row instead of derived from `runs`:

- The orchestrator needs the count before deciding the next transition; a cheap read from the task row avoids a `runs` aggregation on every dispatch.
- The CLI's `task show` needs a single, obvious place to read the current retry count and last failure.
- The `runs` table remains the audit trail; `last_failure` is a denormalized summary for dispatch and display.

### 2. Configurable cap in `~/.marshal/config.json`, default `2`

`GlobalConfig` gains a `policy` section:

```jsonc
// ~/.marshal/config.json
{
  "policy": {
    "maxRetries": 2
  }
}
```

`resolveMaxRetries(config)` returns `config.policy.maxRetries` if it is a non-negative integer, otherwise `DEFAULT_MAX_RETRIES` (`2`).

Why `2` as the default:

- `PROJECT.md` §5.2 says "Cap at N retries (start N = 2 or 3)." `2` gives one automatic re-queue after the first failure, which is enough to absorb transient harness flakiness without hiding persistent problems.
- It is expressed as a count of *retries*, not total attempts. A task may therefore be validated up to three times (initial attempt + 2 retries) before escalating.

### 3. Routing logic in `runOnce()`

The validating branch of `runOnce()` now reads the task's current `retry_count` and the configured `maxRetries`, then routes as follows:

| Validator outcome | `retry_count < maxRetries` | Transition | `retry_count` | `last_failure` |
|---|---|---|---|---|
| `pass` | n/a | `validating → review` | reset to `0` | cleared |
| `fail` (sentinel, absent sentinel, error, spawn failure) | yes | `validating → building` | incremented by 1 | set to reason |
| `fail` (same cases) | no | `validating → review` | unchanged at cap | set to reason |

The failure reason is taken from `result.reason` when present, otherwise `result.error`, falling back to `"unknown validation failure"`. The same reason is stored in both the validator `runs.error` column (existing behavior from ADR-007) and the task's `last_failure` column.

Why reset retry state on pass:

- A passing validation means the task is done with the automated loop. Leaving a stale `last_failure` on a `review` task would make `task show` claim the task failed when it actually succeeded.
- `retry_count` is reset to `0` so a future manual re-queue (Slice 10 escape hatches) starts with a fresh budget.

Why the cap check uses `<` rather than `<=`:

- `retry_count` is the number of retries *already consumed*. After the first failure it is `1`; after the second it is `2`. With the default cap of `2`, the third failure sees `2 < 2` as false and escalates. This matches the intuitive meaning of "2 retries."

### 4. Builder errors do not consume validation retries

The retry cap applies only to the boundary gate (validator). If the builder itself errors, the task stays in `building` per ADR-006 Decision 7 and no retry count is incremented. This keeps the cap focused on "the validator disagreed with the build" rather than "the harness failed to spawn."

### 5. `task show` displays retry count and last failure

`marshal task show <slug>` now prints:

```
retries: 2
last failure: tests are red
```

The `last failure` line is omitted when `last_failure` is null.

## Consequences

- Validation failures are bounded. A task can no longer bounce between `validating` and `building` indefinitely.
- Humans are pulled in after the cap. The escalation path (`validating → review` with a failure summary) preserves context so the reviewer sees why the automated loop gave up.
- The cap is user-configurable without code changes. Power users can tighten or loosen it via `~/.marshal/config.json`.
- `task show` surfaces enough context for a human to decide whether to manually re-queue (Slice 10) or inspect the run log.
- The `runs` table remains the source of truth for full run history; the new `tasks` columns are summary state for dispatch and display.

## Open questions (deferred)

- **Per-task retry overrides.** Some tasks (e.g., large refactors) might deserve a higher cap. A per-task override could live in the working spec or in a future task-level config field.
- **Exponential backoff / cool-off.** M0 retries immediately on the next poll. A future slice could add a delay or a minimum time between retries.
- **Different caps per failure class.** A spawn failure might warrant a different policy than a "tests are red" gate failure. For M0, all non-pass outcomes consume the same budget.
- **Notification on escalation.** Escalating to `review` currently just changes state; a future slice could emit a notification.

## Related

- `docs/M0-VERTICAL-SLICES.md` Slice 7 — implementation scope.
- `docs/PROJECT.md` §5.2 — "Boundary gate fails -> bounce back to Building ... Cap at N retries."
- `docs/adr/ADR-007-validator-run-and-gate.md` — the unbounded bounce-to-building routing that this ADR caps.
- `docs/adr/ADR-006-builder-run-and-run-log.md` — builder error handling; builder errors stay in `building` and do not affect the retry cap.
- `src/tasks/store.ts` — new `retry_count` / `last_failure` columns and helpers.
- `src/worktree/config.ts` — `policy.maxRetries` and `resolveMaxRetries()`.
- `src/daemon/orchestrator.ts` — bounded routing in `runOnce()`.
- `src/tasks/commands.ts` — `task show` output.
