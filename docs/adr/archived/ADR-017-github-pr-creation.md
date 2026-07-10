# ADR-017: GitHub PR Creation Flow

## Status

Accepted — 2026-07-09

Implements `docs/M1-VERTICAL-SLICES.md` Slice 8 (PR Creation).

## Context

Slice 7 supports local merge. Many users will instead want the task branch pushed to GitHub and reviewed through a normal pull request. M1 should support that path without embedding a GitHub OAuth app or turning Marshal into a hosted service.

The host already has Git and may have the GitHub CLI authenticated. For M1, using `gh` keeps credentials and enterprise auth outside Marshal.

## Decisions

### 1. Add a PR creation endpoint backed by `gh`

The daemon will expose:

```text
POST /api/tasks/:slug/pr
```

The endpoint:

1. Resolves the task's worktree branch.
2. Pushes the branch to the configured remote.
3. Runs `gh pr create`.
4. Stores PR metadata on the task.
5. Returns the PR URL.

Response:

```json
{
  "url": "https://github.com/owner/repo/pull/123",
  "number": 123,
  "state": "OPEN"
}
```

Marshal invokes `git` and `gh` with argument arrays and explicit working directories. It does not construct shell command strings.

### 2. Use host `gh` authentication; do not embed OAuth in M1

M1 requires the host's `gh` CLI to be installed and authenticated for the target repository.

If `gh` is missing or unauthenticated, the endpoint returns a clear error envelope. Marshal does not manage tokens, browser OAuth, or GitHub App installation in M1.

### 3. Add task-level PR metadata

To make the board refreshable, PR information must be persisted. Add nullable task fields or an equivalent one-to-one task PR table for:

- `pr_url`
- `pr_number`
- `pr_state`
- `pr_created_at`
- `pr_merged_at`

The task detail API should include PR metadata when present so the Review panel can show the existing PR link after page reload.

### 4. PR creation is idempotent per task

If a task already has `pr_url`, `POST /api/tasks/:slug/pr` should refresh PR state with `gh pr view` and return the existing PR metadata instead of creating a duplicate PR.

If the stored PR no longer exists, return a clear conflict and require human cleanup rather than silently creating a replacement.

### 5. Configure remote and base branch through global config

Configuration keys:

```json
{
  "github": {
    "remote": "origin",
    "baseBranch": "master"
  }
}
```

Defaults:

- `github.remote`: `origin`
- `github.baseBranch`: auto-detected trunk/base branch

The PR title defaults to the task title. The PR body includes the frozen spec markdown so GitHub review has the build contract in context.

### 6. Detect merged PRs through polling, not webhooks

M1 does not run a public webhook receiver. When a task has PR metadata, `GET /api/tasks/:slug` may refresh PR state by running:

```text
gh pr view <number> --json state,mergedAt,url,number
```

When GitHub reports the PR merged:

1. Persist `pr_state = "MERGED"` and `pr_merged_at`.
2. Transition the task to Done if it is still in Review.
3. Clean up the local worktree and task branch when safe.

The local checkout may still need a later `git pull` to contain the merged commit. M1 does not automatically update the user's base branch after detecting a remote merge.

## Consequences

- Marshal supports GitHub-hosted review without taking ownership of GitHub credentials.
- PR links survive page refresh because metadata is persisted with task state.
- Duplicate PRs are avoided by making creation idempotent per task.
- Polling is simple and local-first; webhook support can wait until Marshal has authenticated non-localhost deployment.

## Open questions (deferred)

- **Provider abstraction.** M1 is GitHub-only via `gh`. GitLab/Gitea support would require a provider interface later.
- **Branch deletion after PR merge.** Local branch cleanup is safe after merge detection; remote branch deletion should follow repository/user preference and is deferred.
- **Auth beyond localhost.** Browser-driven PR creation is powerful. Non-localhost daemon access remains unsupported without auth per `docs/PROJECT.md` §8.

## Related

- `docs/M1-VERTICAL-SLICES.md` Slice 8 — PR Creation.
- `docs/adr/ADR-016-diff-review-and-merge.md` — local merge alternative.
- `docs/adr/ADR-010-http-framework.md` — localhost-only daemon security posture.
- `docs/PROJECT.md` §8 — daemon API trust boundary.
