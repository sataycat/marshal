# ADR-005: Spec Freeze at Ready

## Status

Accepted — 2026-07-08

Implements `docs/M0-VERTICAL-SLICES.md` Slice 8 and the freeze contract described in `docs/PROJECT.md` §3.4 and §7.

## Context

`docs/PROJECT.md` defines two distinct spec artifacts per task:

- **Working spec** — `tasks.spec_markdown` in SQLite. Mutable; the source of truth during the authoring / grill-me phase. SQLite is the right home because of concurrent editing and (later) WebSocket broadcast (§3.4).
- **Frozen spec** — `specs/NNNN-<slug>.md`, a committed markdown file on the task branch. Immutable after freeze. This is the build contract the builder reads via git in its worktree. Specs "persist in main as institutional memory after merge" (§3.4).

§7 says: "At the Ready transition, the daemon freezes the working spec: renders it to `specs/NNNN-slug.md` and commits it to the task branch. This frozen file is the immutable contract for the build run... If the spec is wrong mid-build, that is a new build run — unfreeze, revise, re-freeze." The freeze is "the only bridge" between the working spec and the build contract (§3.4).

Slice 8 (`docs/M0-VERTICAL-SLICES.md:145`) scopes the implementation narrowly:

- Render working spec to `specs/<NNNN>-<slug>.md` in the worktree.
- Commit the file to the task branch with message `freeze: <slug>`.
- The builder reads the spec from that file, not from SQLite.
- CLI: `task create` accepts `--spec` or `--spec-file`.

The slice doc leaves two things open that this ADR settles:

1. **Where the worktree and task branch come from at the Ready transition.** Slice 2 (ADR-002, amended by ADR-004) associates the worktree + branch with `WorktreeManager.create(slug)`, and Slice 5 ("Builder Run") describes the builder worktree being created when the orchestrator picks up a `building` task. There is a gap: at the Ready transition (when the freeze needs to run) no worktree or branch exists yet under the Slice 2 lifecycle.
2. **The spec file format** — front-matter, numbering, idempotency. Listed as open ADR question #1 in `docs/M0-VERTICAL-SLICES.md:175`.

This ADR records the decisions. Two open ADR questions from the slice doc remain deferred: #2 (agent prompt templates — Slice 5) and #3/#4/#5 (run-log schema, config, containerization revisit).

## Decisions

### 1. The freeze creates the worktree at Ready (Option A)

`freezeTask(slug)` calls `WorktreeManager.create(slug)` to bring the task branch and worktree into existence at the Ready transition. The spec file is written into that worktree and committed to the branch.

This shifts worktree lifecycle forward by one step relative to the literal Slice 5 scope, which says "a builder worktree is created" at Building. The shift is intentional and small:

- Slice 5's orchestrator reuses the existing worktree via `WorktreeManager.create(slug)`, which already short-circuits to the existing record for the slug (`src/worktree/manager.ts:147-156`). The builder does not create a new worktree; it picks up the frozen one.
- One worktree per task for M0. The validator (Slice 6) will create a *second* worktree from the same task branch; that is Slice 6's addition, not affected by this ADR.
- Concurrency stays at 1 for M0 (per `docs/PROJECT.md` §8). One worktree per task in flight is fine.

Alternatives considered (a transient scratch worktree removed after freeze, or bare-git plumbing without a worktree) add machinery without benefit for M0. Option A reuses the existing, tested worktree path and matches the PROJECT.md phrasing "the builder reads it via git in its worktree" (§7).

### 2. Spec numbering is the task's SQLite auto-increment id, zero-padded to four

`<NNNN>` is `String(task.id).padStart(4, "0")`. The id is already unique per task (the schema's `INTEGER PRIMARY KEY AUTOINCREMENT`, `src/db/schema.sql:2`), so no separate sequence table or file-walk is needed. The full relative path is `specs/0042-add-login.md` for task id 42.

Rationale: SQLite ids are monotonic and stable; they never collide; they require no migration. Four-digit padding covers tasks 1–9999 with sortable filenames; padding widens naturally for ids above 9999 (`specs/10000-...`), which is acceptable since lexical sort still groups by id.

### 3. The frozen file is front-matter + faithful body

The frozen markdown is:

```
---
slug: <slug>
title: "<title>"
task_id: <id>
frozen_at: <iso8601>
---

<spec_markdown body verbatim>
```

The front matter is traceability metadata only. The body is the `spec_markdown` value verbatim, unmodified. Marshal does **not** enforce acceptance-criteria/context/constraints sections in M0 — that is open ADR question #1 in the slice doc, deliberately deferred. The freeze is a faithful render, not a transformation.

`title` is JSON-string-quoted in the YAML to avoid YAML edge cases with colons, leading dashes, or quotes in titles.

If `spec_markdown` is empty or whitespace-only, `freezeTask` refuses with a `FreezeError`. Freezing an empty contract is a no-op and would mislead the builder; the task must be re-authored (still in `backlog`) or unfrozen/revised (see Decision 5) before it can build.

### 4. Commit message: `freeze: <slug>`

Exactly `freeze: <slug>`, matching the slice scope and the GLOSSARY precedent (`docs/GLOSSARY.md:27-29`). No body, no Co-authored-by trailers, no footers in M0. The commit is the single source of truth for "this is the contract at this SHA."

### 5. `marshal task ready <slug>` is the freeze entry point; `task freeze <slug>` is the retry

Two CLI commands touch the freeze:

- **`marshal task ready <slug>`** — transitions `backlog -> ready` and immediately freezes. This is the documented happy path and the only normal way a task enters `ready`. The daemon (Slice 9) will not call this; the human (or, in tests, the test harness) marks a task ready after authoring the spec.
- **`marshal task freeze <slug>`** — calls `freezeTask` directly on a task already in `ready`. Used to retry a failed freeze, or to re-freeze after the spec has been edited in SQLite.

`marshal task transition <slug> ready` remains as a power-user escape hatch that changes state *without* freezing. It is intentionally not the happy path; using it leaves the task in `ready` with no committed spec, and `marshal daemon run-once` (Slice 5 onward) will refuse to build from a task that has no frozen spec.

### 6. Re-freeze is a new commit, not an amend

Running `freezeTask` on a task whose branch already has a `freeze: <slug>` commit creates a **second** `freeze: <slug>` commit on top, not an amend. This keeps the audit trail visible in `git log`: every freeze is a discrete decision. If the human edited `spec_markdown` in SQLite between freezes, the diff between the two freeze commits is exactly the spec delta — reviewable in the eventual Review state.

Idempotency at the file level is already handled by `WorktreeManager.create(slug)` returning the existing worktree for the slug, so a retry does not create a second worktree.

### 7. Failures leave the task in `ready`; recovery is explicit

The `ready` command does `transitionTask(slug, "ready")` first, then `freezeTask(slug)`. If the freeze fails (git error, write error, etc.), the task is left in `ready` with no frozen file, and the CLI prints a recovery hint pointing at `marshal task freeze <slug>`. We deliberately do **not** roll the state back to `backlog`:

- A freeze failure is usually transient or an env issue (git misconfig, worktree disk full), not a spec problem.
- Rolling back would require another valid transition (`ready -> backlog`), which the state machine does not currently allow (see `VALID_TRANSITIONS` in `src/tasks/state-machine.ts:3`), and adding it just for freeze recovery is not worth it for M0.
- The task is observably stuck (no frozen file, status `ready`) and the recovery command is one line. Slice 7's failure routing can revisit if it becomes a UX pain.

## Consequences

- **Slice 5 reuses the frozen worktree.** The builder run does not call `WorktreeManager.create` to make a *new* worktree; it looks up the frozen one. `WorktreeManager.create(slug)` already returns the existing record, so this is the existing code path — no new lookup API is needed.
- **Worktree moves to Ready, not Building, in the lifecycle.** The Slice 5 text should be read as "the orchestrator picks up the *existing* builder worktree" rather than "creates one." Slice 9's integration test and the M0 CLI doc should reflect this.
- **`task ready` is two operations, not one transactional one.** `transitionTask` (SQLite) and `freezeTask` (git + filesystem) cannot share a transaction. A crash between them leaves the task in `ready` without a frozen file; recovery is `marshal task freeze <slug>`. This is documented in Decision 7 and surfaced in the CLI error message.
- **No new DB columns for M0.** `spec_markdown` already exists. The frozen version is not tracked in SQLite in M0 (the frozen SHA lives in git). Slice 7 (retry cap, failure routing) may add a `frozen_at`/`freeze_commit` column when it needs to reference the freeze from the run log; that is Slice 7's call, not this ADR's.
- **Open ADR question #1 (spec format) stays deferred.** This ADR records the *transport* format (front-matter + verbatim body) but explicitly does not mandate sections. When the org has a view on required sections (acceptance criteria, context, constraints), that becomes a new ADR that amends Decision 3.
- **Open ADR question #2 (agent prompt templates) is unchanged.** The builder's prompt (Slice 5) will compose from the frozen file in the worktree plus any orchestrator context; the exact template is Slice 5's ADR territory.

## Open questions (deferred)

- **Spec revision flow.** PROJECT.md §7 says "unfreeze, revise, re-freeze." There is no `marshal task unfreeze` command in M0; the human edits `spec_markdown` in SQLite directly (no `task update` command exists yet either — `spec_markdown` is write-once at `createTask` time, see `src/tasks/store.ts:72-74`). Slice 7 or a later slice will need a `task update --spec` command plus a `task unfreeze` that rolls state from `ready` (or `building`) back to `backlog`. Deferred.
- **Rebasing the frozen branch on trunk.** ADR-004 defers mid-flight rebases to Slice 6/7. The same question applies to the frozen branch: if trunk advances after freeze but before the builder runs, should the freeze commit be rebased? Likely no for M0 (concurrency 1, short window), but Slice 6/7 should decide.
- **Multiple `freeze:` commits on the same branch.** Decision 6 makes each freeze a new commit. Over a long task lifecycle this could pile up. A cleanup/squash policy is a later concern.

## Related

- `docs/PROJECT.md` §3.4, §7 — the working-spec / frozen-spec split and the freeze contract.
- `docs/M0-VERTICAL-SLICES.md` Slice 8 — implementing scope.
- `docs/adr/ADR-002-worktree-isolation.md` — worktree + branch lifecycle (Option A reuses its `WorktreeManager.create`).
- `docs/adr/ADR-004-worktree-base-branch-policy.md` — the task branch base (`origin/<trunk>`) that the freeze commit lands on.
- `docs/GLOSSARY.md:27-29` — "Frozen spec" definition.
- `src/tasks/freeze.ts` — implementation.
- `src/tasks/commands.ts` — `task ready` and `task freeze` CLI commands.