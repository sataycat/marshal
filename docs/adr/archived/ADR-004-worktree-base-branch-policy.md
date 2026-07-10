# ADR-004: Worktree Base Branch Policy (Fetch, Don't Pull)

## Status

Accepted — 2026-07-08

Amends `docs/adr/ADR-002-worktree-isolation.md` (the rule "based on `HEAD` of the source checkout", currently codified at ADR-002 line 40 and implemented at `src/worktree/manager.ts:169` as `git worktree add -b <branch> <path> HEAD`).

## Context

ADR-002 specifies that task branches are created "based on `HEAD` of the source checkout." That is the simplest possible policy and was correct for Slice 2's first pass. But Marshal is an orchestrator that queues tasks over time, and under the current policy:

- Task N+1 starts from whatever local `HEAD` happened to be when the orchestrator claimed the task — not from the latest known-good trunk.
- If the source checkout's local `master` falls behind `origin/master` (which it will, between manual syncs), every subsequent task branch starts behind remote.
- Builder diffs land on stale code; the validator (Slice 6) reviews stale code; merges back to trunk accumulate drift and avoidable conflicts.

This is not a personal-use quirk. It is a structural drift bug for any orchestration loop that runs more than one task between human syncs. The question is whether to (a) leave it as a human responsibility ("run `git pull` before you start the daemon"), (b) have Marshal mutate the source checkout with `git pull`, or (c) have Marshal fetch non-mutatingly and base task branches on the remote-tracking ref.

## Prior art

- **Conductor** bases worktrees on the user's current branch and warns if it is behind remote; it does not auto-sync.
- **Paseo** runs an optional `worktree.setup` script but leaves branch-base selection to the user's checkout state.
- **Codex** defaults to the current branch but supports a `--base` flag to specify an arbitrary ref, including `origin/main`.

None of them auto-pull. All assume the human keeps the source checkout fresh. That assumption holds for an interactive single-user tool; it breaks for an unattended orchestrator that runs tasks while the human is away.

## Decisions

### 1. Base task branches on `origin/<trunk>`, not on local `HEAD`

The task branch `marshal/task/<slug>-<descriptor>` is created from `origin/<trunk>` (the remote-tracking ref), not from the source checkout's `HEAD`. This replaces the rule in ADR-002 line 40.

`<trunk>` is the repo's default branch. Marshal auto-detects it on first run via `git symbolic-ref refs/remotes/origin/HEAD` (falling back to `main`, then `master`), and the result is cached per repo.

### 2. Fetch before branching; never pull

`WorktreeManager.create()` runs `git fetch origin <trunk>` immediately before creating the task branch. Marshal uses **`fetch`, not `pull`**:

- `git pull` merges into the source checkout's local branch, mutating the user's working state and potentially creating conflicts the human must resolve.
- `git fetch` only updates remote-tracking refs. The source checkout is left exactly as the human left it.

The source checkout is treated as a pristine reference for paths and config, not as the source of truth for trunk contents. This preserves the existing `ensureCleanEnough()` behavior (`manager.ts:90`) — uncommitted changes in the source checkout no longer matter for branch base, because the base is `origin/<trunk>`.

### 3. Configurable trunk override

`marshal.json` → `worktree.base` overrides auto-detection. This follows the existing `worktree.setup` / `worktree.root` config precedent (see `src/worktree/config.ts`).

- `"origin/main"`, `"origin/master"`, `"origin/dev"` — explicit remote-tracking ref.
- `"HEAD"` — opt out of this ADR entirely and revert to ADR-002's behavior (useful for offline work, detached-HEAD workflows, or single-user repos where the human always syncs).

Default (field absent): auto-detect as in Decision 1.

### 4. Failure mode when remote is unreachable

If `git fetch` fails (network down, auth required, no `origin` remote):

- **Default (lenient)**: fall back to the local remote-tracking ref `origin/<trunk>` as-is (which may be stale) and emit a structured warning. Do not block the run. A stale base is usually still buildable; the warning keeps drift visible.
- **Strict mode**: `marshal.json` → `worktree.requireUpToDate: true` makes fetch failure hard-fatal. Use this for CI-style runs where staleness is worse than blocking.

The default is lenient because Marshal should degrade gracefully; strict mode is opt-in for environments that prefer to fail closed.

### 5. Reopens M0 Slice 2 implementation

ADR-002 and `docs/M0-VERTICAL-SLICES.md` Slice 2 are both marked **COMPLETE**. This ADR changes the base-branch policy that Slice 2 implemented. Concretely, `WorktreeManager.create()` gains:

- A `trunk` resolution step (auto-detect via `git symbolic-ref`, or read `worktree.base`).
- A `git fetch origin <trunk>` step before `git worktree add -b <branch> <path> <start-point>`.
- Handling for fetch failure per Decision 4 (warn-and-continue or hard-fail).
- The `HEAD` start-point at `manager.ts:169` becomes `origin/<trunk>` (or whatever `worktree.base` resolves to).

Slice 2's status in `M0-VERTICAL-SLICES.md` should be amended to reflect this change (e.g. "COMPLETE — base-branch policy amended by ADR-004").

## Consequences

- **No drift accumulation across tasks.** Each new task starts from current remote trunk, regardless of when the human last synced the local checkout.
- **Source checkout is never mutated by Marshal.** `fetch`-only keeps the user's working state pristine; humans retain full control over their local branches.
- **Network becomes a worktree-creation dependency.** Under the default lenient failure mode this degrades to stale-but-buildable with a warning; under strict mode it blocks. Either way, offline use can opt out via `worktree.base: "HEAD"`.
- **Configurable trunk supports non-`master` repos.** `main`, `dev`, and `release/*` workflows all work via override.
- **Small implementation cost on a "done" slice.** `WorktreeManager.create()` gains roughly 15 lines plus tests. The change is local; no other slice is affected.
- **ADR-002 line 40 is superseded.** The rest of ADR-002 (`.worktreeinclude`, setup scripts, worktree location, descriptor scheme, cleanup) is unchanged.
- **`ensureCleanEnough()` becomes less load-bearing.** With base = `origin/<trunk>`, uncommitted changes in the source checkout no longer affect the task branch. The check is kept as a diagnostic warning but no longer gates correctness.

## Open questions (deferred)

- **Rebasing task branches mid-flight.** If trunk advances while a builder is running, should Marshal rebase the task branch on a fresh fetch before validation? Deferred to Slice 6/7; likely no for M0 (concurrency 1, short runs).
- **Multi-remote trunks.** Forks that build against `upstream/main` but push to `origin`. The `worktree.base` override handles this for now; a richer multi-remote config is a later concern.
- **Fetch depth.** `git fetch origin <trunk>` is full-fetch by default. A `--depth` option for large repos is a later optimization.
- **Caching auto-detected trunk.** Where and for how long to cache the `git symbolic-ref` result. Likely in `.marshal/` per-repo state alongside `worktrees.json`; deferred to implementation.

## Related

- `docs/adr/ADR-002-worktree-isolation.md` — amended here (line 40 base-branch rule).
- `docs/adr/ADR-001-node-backend-and-embedded-react.md` decision #4 — bare-host isolation context; this ADR does not change isolation, only base-branch selection.
- `docs/M0-VERTICAL-SLICES.md` Slice 2 — implementation amended by this ADR.
- `src/worktree/manager.ts:169` — the exact call site changed.
- `src/worktree/config.ts` — the `MarshalJson.worktree` shape extended with `base` and `requireUpToDate`.
- Prior art: Conductor, Paseo, Codex worktree base-branch behavior (referenced 2026-07-08).
