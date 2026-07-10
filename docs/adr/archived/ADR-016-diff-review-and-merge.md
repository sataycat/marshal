# ADR-016: Diff Review and Local Merge Flow

## Status

Accepted — 2026-07-09

Implements `docs/M1-VERTICAL-SLICES.md` Slice 7 (Diff Review Panel).

## Context

Review is one of Marshal's two human judgment points. By the time a task reaches Review, the human needs to inspect the builder's diff and either merge it or send it back to authoring.

Marshal already creates one branch and worktree per task. Slice 7 exposes the branch diff over HTTP and adds a local merge path for users who do not want to create a GitHub PR.

## Decisions

### 1. Add a read-only diff endpoint for Review tasks

The daemon will expose:

```text
GET /api/tasks/:slug/diff
```

Response:

```json
{
  "diff": "diff --git ...",
  "stats": {
    "files": 2,
    "insertions": 10,
    "deletions": 3
  }
}
```

The endpoint resolves the task's branch through `WorktreeManager`'s index and runs Git with argument arrays, not shell strings.

The diff compares:

```text
<base branch>...<task branch>
```

The base branch defaults to the detected trunk/current configured base from the worktree policy. A future config key may override it if needed.

### 2. Render a unified diff first; split view is optional

The browser should support a readable unified diff in M1. A split-view toggle can be added if the chosen diff library provides it cheaply, but the acceptance criterion is satisfied by a syntax-highlighted unified diff.

The diff library must run entirely in the browser over the unified diff text. It must not require daemon-side HTML generation.

### 3. Local "Approve & Merge" creates a merge commit

The local merge endpoint is:

```text
POST /api/tasks/:slug/merge
```

It performs a non-fast-forward merge of the task branch into the base branch:

```text
git merge --no-ff <task-branch>
```

Rationale:

- Preserve the frozen spec commit and builder commit history as task provenance.
- Keep task branches auditable after merge.
- Avoid rewriting builder history during the first human-reviewed flow.

Squash and rebase are deferred until there is user demand for a cleaner linear history.

### 4. Merge preconditions are strict

The merge endpoint only runs when:

- the task exists
- the task is in `review`
- the worktree index has a branch for the task
- the source checkout is on the configured base branch
- the source checkout is clean enough to merge safely

If any precondition fails, return an error envelope and do not modify task state.

Merge conflicts return `409` and leave the task in Review with the worktree preserved for inspection. The endpoint must not auto-resolve conflicts.

### 5. Transition to Done and clean up only after merge succeeds

On successful merge:

1. Capture the resulting `HEAD` SHA.
2. Transition the task `review → done`.
3. Destroy the task worktree and delete the task branch through `WorktreeManager.destroy`.
4. Return `{ "merged": true, "commitSha": "<sha>" }`.

If cleanup fails after a successful merge, the API should surface that cleanup error instead of pretending everything completed. The task should not be marked Done until the merge and cleanup sequence has completed.

### 6. Add `review → backlog` for Send Back

"Send Back" from Review is not a merge operation. Slice 7 adds a manual `review → backlog` transition for this action.

The transition should behave like the existing escape hatches from ADR-009:

- human-driven only
- retry state reset
- `last_failure` cleared
- worktree preserved for inspection and possible manual salvage

Cleanup only belongs to successful merge.

## Consequences

- Users can complete the local-only Review flow without GitHub.
- Merge commits preserve Marshal's task provenance and frozen spec history.
- Strict preconditions reduce the chance of merging into the wrong branch or mixing user work into a task merge.
- Conflicts remain a human problem, which is correct for the Review state.
- Review can route back to authoring without SQL surgery while keeping the task worktree available for inspection.

## Open questions (deferred)

- **Squash or rebase strategy.** Non-fast-forward merge is the first strategy. Add configurable squash/rebase only after the local merge flow proves useful.
- **Review comments.** Inline comments on diffs are M2 scope.
- **Base branch detection.** M1 can rely on the existing worktree base policy; richer per-task base branches can be added later.

## Related

- `docs/M1-VERTICAL-SLICES.md` Slice 7 — Diff Review Panel.
- `docs/adr/ADR-002-worktree-isolation.md` — one isolated worktree per task.
- `docs/adr/ADR-004-worktree-base-branch-policy.md` — base branch policy.
- `docs/adr/ADR-005-spec-freeze-at-ready.md` — frozen spec provenance.
- `docs/adr/ADR-009-escape-hatch-transitions.md` — manual recovery semantics.
