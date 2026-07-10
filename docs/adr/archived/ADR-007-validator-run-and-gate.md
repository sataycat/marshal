# ADR-007: Validator Run and Gate

## Status

Accepted — 2026-07-08

Implements `docs/M0-VERTICAL-SLICES.md` Slice 6 (Validator Run & Gate). Settles the validator half of open ADR question #2 (agent prompt templates) from `docs/M0-VERTICAL-SLICES.md:198`, and the validator side of open ADR question #4 (configuration).

## Context

Slices 1–5, 8 are complete. After Slice 5, `runOnce()` claims a `ready` task, runs the builder (`opencode`) in the frozen worktree, and leaves the task in `validating`. Slice 6 closes the loop: run the configured validator harness against the build delta, and route the pass/fail decision through the state machine.

The validator is the boundary gate (PROJECT.md §6) — the second-line check the design stakes the whole product on. Its properties, settled here:

- **Decorrelated.** A different agent from the builder. The default is `pi` (PROJECT.md §5.1: "opencode as builder, pi as validator"). Users wire their own validator in `~/.marshal/config.json` during onboarding.
- **Read-only.** Inspects the build delta and the spec, runs tests, returns a binary decision. Does not commit.
- **Same fs as the builder.** The "separate disposable worktree" language in PROJECT.md §6 was about *who runs the tests* (a different model), not about a different filesystem. The builder commits cleanly (ADR-006 Decision 5: `git add -A && git commit --allow-empty`), so the builder's worktree is already a clean checkout of the build commit. Creating a second worktree for the validator adds include-copy and setup-script cost with no isolation benefit, since the validator's role is *read+execute tests*, not *modify the tree*.

Two open ADR questions from `docs/M0-VERTICAL-SLICES.md:198` land here:

- **#2 — Agent prompt templates (validator half).** ADR-006 settled the builder side. This ADR settles the validator side: composition is different (spec + diff, not just spec), the diff is truncated to avoid prompt blow-up, and the agent emits a sentinel line that the orchestrator parses into a structured gate decision.
- **#4 — Configuration (validator agent ID).** The validator ID is the first config-driven agent in the orchestrator. This ADR settles the config schema (`GlobalConfig.agents.validator`), the default, and the helper.

## Decisions

### 1. `runOnce()` selects FIFO across `ready` and `validating`; one function owns claim+route

`runOnce()` is the only function the polling loop calls. It selects the oldest task whose status is `ready` or `validating` and dispatches internally:

1. **Select** — `SELECT * FROM tasks WHERE status IN ('ready', 'validating') ORDER BY created_at ASC, id ASC LIMIT 1`. FIFO by creation time across both buildable and validatable tasks. `ready` tasks win ties because they appear first in the same `ORDER BY` (their `created_at` is earlier by construction — a task enters `ready` before it ever enters `validating`).
2. **If `ready`** — pre-flight (worktree exists, frozen spec exists per ADR-005 Decision 5), claim (`ready → building`), `buildTask()`, route on result (built → `validating`; error → stays in `building` per ADR-006 Decision 7). This is the existing Slice 5 path unchanged.
3. **If `validating`** — pre-flight (worktree still exists, build commit present), `validateTask()`, route on result (pass → `review`; fail → `building`).

The function returns the same `RunOnceResult` shape as Slice 5 (`{ slug, runId, commitSha, status, error? }`), with `status` extended to include `"validated"` and `"validation_failed"` so the CLI can print what happened. `commitSha` is the build commit SHA (echoed from the most recent builder run log row, not a new commit — the validator does not commit).

Why one function: Slice 9's `marshal daemon run-once` calls a single entry point. Splitting into `runOnce` (build) and `validateOnce` would force the CLI to know the dispatch logic, which belongs in the orchestrator. The state machine is the source of truth for "what should I do next" — the orchestrator just reads it.

Why FIFO across both states: a `ready` task that's been waiting longer than a `validating` task should not be starved. Concurrency is 1 (PROJECT.md §6) and the order is stable: a task moves `ready → building → validating → review` and only the new claim is gated on `ready`. A stuck `validating` task that bounces back to `building` re-enters the queue at the head with a fresh `updated_at` (Slice 7 will add the cap; for M0, FIFO is sufficient).

Why `ready` wins ties: the builder's output is the validator's input. A `ready` task is closer to the head of the pipeline than a `validating` task that hasn't finished. Processing `ready` first keeps the pipeline moving when the queue is mixed.

### 2. Validator runs in the builder's worktree — no second worktree

`validateTask(slug)` reuses the existing worktree via `WorktreeManager.create(slug)` (the idempotent-return path; ADR-002 + ADR-005). No `git worktree add` for the validator, no second include copy, no second setup script run.

Why:

- **The builder committed cleanly.** ADR-006 Decision 5: `git add -A && git commit --allow-empty` always commits. The worktree is at a clean build commit when the validator starts.
- **The validator is read-only.** It runs tests, reads files, inspects the diff. Its only filesystem writes are test artifacts (e.g. `node_modules/`, build outputs), which are gitignored and don't affect the branch.
- **Decorrelation comes from the agent, not the fs.** A second worktree does not make the validator model "more independent" — the same model running in a different directory makes the same mistakes. The different agent is what gives us a second opinion. PROJECT.md §6 calls this "a different model in a clean worktree" but the "clean worktree" requirement is satisfied by the builder's `--allow-empty` commit, not by a second `git worktree add`.
- **Cost saved.** A second worktree would double the include-copy and setup-script runtime for every validation. M0's polling loop is simple; doubling per-validate cost without a correctness benefit is the wrong tradeoff.

The validator's ACPX session is fresh per run (per ADR-003 Decision 3, the session scope key is `(agentCommand, cwd, name)`): name `marshal-<slug>-validator`, cwd = the builder's worktree. Different session, same cwd. The agent is "looking at the same code from a different chair" — which is exactly the "decorrelated" property PROJECT.md §6 is after.

### 3. Pass/fail: sentinel in text, parsed by the orchestrator

The validator agent is prompted to emit a final line of one of two forms:

```
MARSHAL_GATE: pass
MARSHAL_GATE: fail <reason>
```

The orchestrator scans the text events emitted by the validator and produces an internal `GateResult`:

```ts
export type GateResult =
  | { result: "pass" }
  | { result: "fail"; reason: string }
  | { result: "absent" };  // no sentinel seen — treated as fail with reason "no gate decision emitted"
```

Why a sentinel in text:

- **No new `AgentEvent` type.** The `AgentEvent` protocol stays generic across builder, validator, and any future role. The marshal-specific gate concept is orchestrator-owned, not protocol-owned.
- **No string-parsing of free-form agent prose.** The sentinel is a precise, expected pattern. The orchestrator regexes for it in text events only; tool/log/done events don't carry the gate. The validator's prompt is the only place the format is defined.
- **Easy to test.** A fake `Agent` yields text events; the parser is a pure function.
- **"absent" is conservative.** If the agent forgets the sentinel, times out, or emits a malformed line, the orchestrator treats it as fail with a fixed reason. The run log records the reason. Slice 7's retry cap bounds the resulting `validating → building` bounces.

The parser is line-based and case-sensitive (`MARSHAL_GATE:` uppercase, exactly one space after the colon). Multiple matches in a single run: the first complete, well-formed line wins. A `pass` followed by a `fail` is treated as the first decision (`pass`); the agent is told in the prompt to emit exactly one final line.

### 4. Validator prompt: spec + truncated diff, with a pointer for the full thing

The prompt (rendered by `renderValidatorPrompt(task, diff, trunkRef)`):

```
You are validating the implementation of task "{title}" (slug: {slug}).

## Spec

{spec_markdown}

## Diff (truncated to {N} of {M} lines)

Base: {trunkRef}
Run `git diff {trunkRef}...HEAD` in this directory to see the full diff if needed.

{diff}

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

Composition notes:

- **Spec inlined verbatim** from `task.spec_markdown` (SQLite). Same precedent as ADR-006 Decision 3 (builder template inlines from SQLite). The frozen file `specs/<NNNN>-<slug>.md` is the audit trail; the prompt inlines for prompt-efficiency, not as a replacement.
- **Diff computed in the worktree** as `git diff <trunkRef>...HEAD`, where `<trunkRef>` is auto-detected (Decision 6). For M0 the diff is the build delta minus the spec file (the spec was added in the freeze commit; it appears in the diff against the worktree's start point, but it's content the validator already has inlined above the diff). We exclude `specs/` from the diff with `git diff <trunkRef>...HEAD -- . ':!specs/'` to avoid double-printing.
- **Diff truncated to 2000 lines** with a header line `Base: <trunkRef>` and a hint to run `git diff` for more. 2000 is a soft cap that fits comfortably in the agent's context window alongside the spec. Real-world diffs that exceed 2000 lines point to a build that's too large for one slice — a real signal the human should split the task.
- **No spec file path in the prompt.** Same as the builder template (ADR-006 Decision 3): the spec is inline, the file is for audit.

### 5. `agents.validator` in `~/.marshal/config.json`, default `"pi"`

`GlobalConfig` gains an `agents` section:

```jsonc
// ~/.marshal/config.json
{
  "agents": {
    "builder": "opencode",  // optional; reads default "opencode" if absent
    "validator": "pi"        // optional; reads default "pi" if absent
  }
}
```

A new helper `resolveAgentId(role: "builder" | "validator"): AgentId` reads `config.agents[role]`, falls back to the role's default (`"opencode"` for builder, `"pi"` for validator), and validates that the value is a known `AgentId`. The orchestrator calls `resolveAgentId("validator")` at validate time — the validator agent ID is resolved at run time, not hard-coded.

The `builder` field is added for symmetry and so a future slice can move the hard-coded `"opencode"` out of `orchestrator.ts` without a config-schema migration. M0 reads only `validator`.

The default `"pi"` for validator matches PROJECT.md §3.3 and §5.1's design choice. PROJECT.md §5.1 says the M0 design uses "opencode as builder, pi as validator"; the default encodes that. The user wires a different validator during onboarding by editing `~/.marshal/config.json` — no code change.

### 6. Diff base: auto-detected local trunk

`detectTrunkRef(worktreePath: string): string` runs, in order:

1. `git symbolic-ref refs/remotes/origin/HEAD` (the canonical trunk ref Git sets up on clone).
2. `git rev-parse --verify origin/main` — fall back to `main`.
3. `git rev-parse --verify origin/master` — fall back to `master`.
4. `git rev-parse --verify main` — fall back to the local `main` if no remote.
5. `git rev-parse --verify master` — last resort.
6. Throw `NoTrunkRefError` if all five fail.

The first successful lookup wins. The result is the `<trunkRef>` string used in `git diff <trunkRef>...HEAD` for the validator prompt.

For M0 the diff base is the *local* trunk ref, not `origin/<trunk>` — because ADR-004's "fetch, don't pull" base-branch policy is documented (ADR-004) but not yet wired into `WorktreeManager.create()` (which still uses `HEAD` at `src/worktree/manager.ts:169`). Once ADR-004 is implemented, the diff base should become the same `origin/<trunk>` the branch was created from, so the diff is exactly the build's contribution with no drift from a stale local checkout. This is an open question (deferred).

The detected trunk is per-validate (no caching across runs in M0). Caching belongs alongside the worktree index when ADR-004 is implemented.

### 7. Validator routing: pass → `review`; fail → `building`

`validateTask(slug)` returns `{ slug, runId, status: "validated" | "validation_failed", reason? }`. The caller (the new branch in `runOnce`, Decision 1) does the state transition:

| Validator outcome | Task transition | `runOnce` returns |
|---|---|---|
| `pass` | `validating → review` | `{ status: "validated" }` |
| `fail` (sentinel `fail <reason>`) | `validating → building` | `{ status: "validation_failed", reason }` |
| `absent` (no sentinel) | `validating → building` | `{ status: "validation_failed", reason: "no gate decision emitted" }` |
| Validator `spawn` throws | `validating → building` | `{ status: "validation_failed", reason: "spawn failed: ..." }` |
| Validator stream `error` event | `validating → building` | `{ status: "validation_failed", reason: <event.message> }` |
| Validator timeout (exit 3) | `validating → building` | `{ status: "validation_failed", reason: "timeout" }` |

The task is *never* left in `validating` on a non-pass outcome. The state machine has no valid transition `validating → validating` (the only auto-transitions are `→ building` and `→ review`), so leaving the task in `validating` would brick it. Bouncing to `building` is the conservative choice; Slice 7's retry cap will bound the resulting loop.

The validator does **not** commit. The `build:` commit is the only commit on the task branch produced by the orchestrator. The validator may write test artifacts (`node_modules/`, `.cache/`, etc.) — these are gitignored and don't affect the branch. The validator may also modify tracked files if it has to fix something it found, but the slice prompt says "decide pass/fail" and the model is told not to commit; any uncommitted changes the validator leaves behind are caught by the next builder run's `git add -A && git commit --allow-empty` and folded into the next `build:` commit. This is acceptable for M0: validation is read-only, but the safety net absorbs any rogue writes.

The failure reason is stored on the validator's `runs` row in the `error` column (alongside `commitSha` left `null` — the validator doesn't commit). `task show` (Slice 7) surfaces it.

### 8. Validator session: same Agent interface, different name, same defaults

Per ADR-003 Decision 3, the session scope key is `(agentCommand, cwd, name)`. The validator session:

- **Name**: `marshal-<slug>-validator` — mirrors the builder's `marshal-<slug>-builder` (ADR-006 Decision 4). The two sessions are distinct even though they share cwd, because name is part of the scope key.
- **Agent**: `resolveAgentId("validator")` (Decision 5). Default `"pi"`.
- **Permission mode**: `--approve-all --non-interactive-permissions fail` (ADR-003 Decision 4 default, same as the builder).
- **Timeout**: 1800s (ADR-003 default, same as the builder). Configurable via `SpawnOptions.timeoutSeconds` if a future harness needs more.
- **Lifecycle**: `spawn` (ensure) → `prompt` (stream, text scanned for the sentinel) → `close` (in a `finally` block, same as the builder).

`validateTask` is injectable for tests the same way `buildTask` is (Slice 5 Decision 1): the `Agent` is a parameter on the function, production constructs `new AcpxAgentAdapter()`, tests pass a fake that yields canned `AgentEvent`s.

### 9. CLI commands are Slice 9; Slice 6 delivers the functions

Slice 6 delivers `runOnce()` (extended), `validateTask()`, and `renderValidatorPrompt()` as importable functions in `src/daemon/orchestrator.ts`, plus the `resolveAgentId()` helper in `src/worktree/config.ts`. The CLI commands that drive them are Slice 9's scope (`marshal daemon run-once`, `marshal daemon start`).

Slice 6's acceptance test is the orchestrator test that calls `runOnce()` directly with a fake `Agent`, same pattern as Slice 5. The integration test with a real repo and stub harness is Slice 9.

### 10. File layout

| File | Responsibility |
|---|---|
| `src/daemon/orchestrator.ts` | extended `runOnce()`; new `validateTask()`, `renderValidatorPrompt()`, `parseGateSentinel()`, `detectTrunkRef()` |
| `src/worktree/config.ts` | `GlobalConfig.agents`; new `resolveAgentId(role)` helper |
| `src/daemon/orchestrator.test.ts` | tests for validate flow, sentinel parsing, runOnce dispatch over ready+validating |
| `src/worktree/config.test.ts` | tests for `resolveAgentId()` (default, override, invalid) |

No new DB tables, no schema change. The validator run reuses the `runs` and `run_events` tables from ADR-006 (with `role = 'validator'`). No new CLI commands in Slice 6 (Decision 9).

## Consequences

- **No second worktree per validate.** Include copy and setup script run once per task lifetime, not once per build+validate. This is the main cost win of Decision 2.
- **Single `runOnce()` for the polling loop.** Slice 9's `daemon run-once` and `daemon start` call one function. The state machine is the source of truth for dispatch.
- **Validator agent is config-driven.** `~/.marshal/config.json` → `agents.validator` wires any `AgentId` the user has API keys for. The orchestrator's code is harness-agnostic; it never references `pi` or `opencode` directly. (Builder stays hard-coded `"opencode"` in `orchestrator.ts` per ADR-006 Decision 4; the config field exists for symmetry and is read by a future slice.)
- **Pass/fail is text-sentinel-based.** No new `AgentEvent` type; the protocol stays generic. The orchestrator owns the marshal-specific gate semantics. Easy to test, easy to change.
- **The validator's failure reason is structured but the agent's emission is plain text.** A `MARSHAL_GATE: fail <reason>` line in the agent's output becomes a `runs.error` column in SQLite, surfaced by `task show` in Slice 7. The round trip is: agent text → orchestrator parse → SQLite → CLI display.
- **The task is never left in `validating` on a non-pass.** The state machine has no `validating → validating` edge; bouncing to `building` is the only way to keep the queue moving. Slice 7's cap will bound the resulting bounce loop.
- **Diff base is local trunk, not `origin/<trunk>`.** This is a temporary limitation that will be lifted when ADR-004 is wired into the manager. For M0 (concurrency 1, short windows) it's acceptable.
- **Slice 7 reuses the validator run log for retry context.** When a validator fails and bounces to `building`, Slice 7's bounce-back prompt appends the previous validator's `reason` and a pointer to its run log. The `runs` table's `error` column is the source.
- **`task show` (Slice 7) gains validator run history.** Same query pattern as builder runs: `SELECT * FROM runs WHERE task_id = ? AND role = 'validator' ORDER BY started_at DESC`.
- **Open ADR question #2 (agent prompt templates) is fully settled.** Builder settled in ADR-006 Decision 3; validator settled here in Decision 4.
- **Open ADR question #4 (configuration) is partially settled.** Validator agent ID is config-driven. Builder agent ID stays hard-coded for now but the config field exists. Broader config-location question (global vs per-repo vs env vs CLI) is still deferred.
- **Crash recovery is still not handled in M0.** A `validating` task whose `runs` row is `running` and whose `ended_at` is `null` indicates a crashed validation. The bounce-to-`building` rule covers it (the task is no longer in `validating` after the bounce), but a future slice should mark stale `running` runs as `error` on daemon startup.

## Open questions (deferred)

- **Diff base = `origin/<trunk>`.** ADR-004's fetch-from-`origin/<trunk>` policy is not yet implemented in `WorktreeManager.create()`. Once it lands, `detectTrunkRef` should use the same `origin/<trunk>` the branch was created from, so the diff is the build's exact contribution. Until then, the diff may include unrelated trunk drift.
- **Trunk ref caching.** `detectTrunkRef` runs per validate for M0. Caching the auto-detected ref per repo (alongside the worktree index) is a small optimization.
- **Multiple sentinel lines.** The parser takes the first well-formed match. A more robust future implementation could require exactly one sentinel and error on multiple, but M0's "first wins" rule is good enough.
- **Validator timeout and harness-specific overrides.** The 1800s default is ADR-003's. A per-agent override in `~/.marshal/config.json` (e.g. `agents.validator.timeoutSeconds`) is a small addition when needed.
- **Spec file path in prompt.** The frozen spec file is the audit trail; we inline from SQLite for prompt efficiency. If a future slice needs the agent to *also* see front-matter (e.g. `frozen_at` for "how stale is this spec?"), the path can be added.
- **Validator session reuse across retries.** Slice 7's bounce-back may want to close the previous validator's session explicitly and start a fresh one — same `name` is fine because `sessions ensure` is idempotent.
- **`build:` commit on the validator's branch tip.** The validator's session is cwd-scoped to the same branch the builder committed on. If the validator accidentally commits (despite the prompt instruction not to), the commit lands on the task branch and is included in the next validate's diff. The orchestrator does not protect against this in M0.

## Related

- `docs/M0-VERTICAL-SLICES.md` Slice 6 — implementing scope.
- `docs/PROJECT.md` §5.1 (board states — `Validating` is the boundary gate's state), §6 (boundary gate vs in-loop gate; "different model in a clean worktree" — the clean-worktree part is satisfied by the builder's commit, not a second `git worktree add`), §3.3 (opencode builder, pi validator, harness-agnostic via ACP).
- `docs/adr/ADR-006-builder-run-and-run-log.md` — the `runOnce()` / `buildTask()` / `RunLog` pattern that this slice extends. Decision 5 (`build:` commit) is the precondition for reusing the builder's worktree.
- `docs/adr/ADR-003-agent-adapter-and-acpx.md` — the `Agent` interface, session scope key `(agentCommand, cwd, name)`, permission defaults, event types that `validateTask` consumes.
- `docs/adr/ADR-002-worktree-isolation.md` — `WorktreeManager.create(slug)` idempotent-return, reused by `validateTask`.
- `docs/adr/ADR-005-spec-freeze-at-ready.md` — the frozen spec file the validator references; the inline-from-SQLite pattern in the prompt mirrors ADR-006's builder pattern.
- `docs/adr/ADR-004-worktree-base-branch-policy.md` — diff base is local trunk for M0; will become `origin/<trunk>` when ADR-004 is implemented in the manager.
- `src/daemon/orchestrator.ts` — extended with `validateTask`, `renderValidatorPrompt`, `parseGateSentinel`, `detectTrunkRef`; `runOnce` gets the new `validating` branch.
- `src/worktree/config.ts` — `GlobalConfig.agents` added; `resolveAgentId(role)` helper.
- `src/daemon/run-log.ts` — reused unchanged (`role: "validator"`, no new fields).
- `src/agent/types.ts` — `Agent` and `AgentEvent` reused unchanged (no new event type for the gate).
- `src/tasks/state-machine.ts:3` — `VALID_TRANSITIONS` already includes `validating → building` and `validating → review` (Slice 3).
