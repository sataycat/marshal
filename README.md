# Marshal

A local-first, agent-agnostic coding-agent orchestrator built around a build-verify-review loop: you author the spec, an agent builds autonomously in an isolated git worktree, a dedicated validator gate checks the result, and you review and merge.

M0 is the headless vertical slice — no UI, just CLI commands and logs. See [`docs/PROJECT.md`](docs/PROJECT.md) for the full design and [`docs/M0-VERTICAL-SLICES.md`](docs/M0-VERTICAL-SLICES.md) for the slice breakdown.

## Requirements

- Node.js (ES2022)
- pnpm (`pnpm@11.10.0` is pinned via `packageManager`)
- git
- [acpx](https://github.com/openclaw/acpx) on PATH (the ACP client the daemon shells out to)
- A builder agent and a validator agent reachable through ACPX (M0 ships with `opencode` as builder and `pi` as validator)

## Install

```sh
pnpm install
pnpm run build
```

This produces `dist/` and makes `bin/marshal` runnable. To use `marshal` from anywhere, link or install the package globally (`npm link` from the repo root).

## Configuration

### Global config (`~/.marshal/config.json`)

```jsonc
{
  "worktree": {
    "root": "~/.marshal/worktrees"   // where task worktrees are created
  },
  "acpx": {
    "bin": "acpx",                   // path to the acpx binary
    "version": ">=0.12.0 <0.13.0"    // expected acpx version range
  },
  "agents": {
    "builder": "opencode",           // builder agent id
    "validator": "pi"                // validator agent id
  },
  "policy": {
    "maxRetries": 2                  // validation retry cap before escalating to review
  }
}
```

The `MARSHAL_GLOBAL_CONFIG` env var overrides the config file path (useful for tests).

### Per-repo config (`marshal.json`)

```jsonc
{
  "worktree": {
    "setup": "pnpm install"          // shell command run after each worktree is created
  }
}
```

A `.worktreeinclude` file in the repo root lists gitignored files to copy into worktrees (e.g. `.env.local`).

## M0 workflow

State is per-repo, discovered via the current working directory (same model as git).

### 1. Initialize

```sh
cd your-repo
marshal init
```

Creates `.marshal/` (state directory + SQLite database).

### 2. Author a task

```sh
marshal task create \
  --slug add-feature \
  --title "Add the feature" \
  --spec "## Goal\nImplement the feature.\n\n## Acceptance Criteria\n- Tests pass."
```

Or point at a spec file:

```sh
marshal task create --slug add-feature --title "Add the feature" --spec-file ./spec.md
```

The task starts in `backlog`. Inspect it with `marshal task show add-feature`.

### 3. Freeze the spec and mark ready

```sh
marshal task ready add-feature
```

This transitions the task to `ready`, renders the working spec to `specs/<NNNN>-<slug>.md`, commits it to a task branch (`marshal/task/<slug>-<descriptor>`), and creates the worktree. The frozen spec is the immutable contract for the build.

### 4. Run the loop

Pick up one ready/validating task and run a single orchestrator cycle:

```sh
marshal daemon run-once
```

Or run the daemon continuously (polls every 5s by default):

```sh
marshal daemon start
marshal daemon start --interval 10000   # poll every 10s
```

The daemon is single-threaded (concurrency 1). Each cycle:

- A `ready` task is claimed, transitioned to `building`, the builder agent (`opencode` by default) runs in the worktree against the frozen spec, changes are committed, and the task moves to `validating`.
- A `validating` task is checked by the validator agent (`pi` by default). The validator emits a `MARSHAL_GATE: pass` or `MARSHAL_GATE: fail <reason>` sentinel. On pass the task moves to `review`; on fail it bounces to `building` (up to `maxRetries` times) and then escalates to `review`.

Stop the daemon with `Ctrl-C` (SIGINT/SIGTERM).

### 5. Review

```sh
marshal task show add-feature
```

When the task reaches `review`, inspect the diff in the task worktree and merge or send it back. Use `marshal task transition <slug> <state>` for manual state changes, including the escape hatches (`building -> ready`, `building -> backlog`, `validating -> backlog`).

### Task states

```
backlog -> ready -> building -> validating -> review -> done
                       |           |
                       +-> ready   +-> building (retry)
                       +-> backlog +-> backlog
                                   +-> review (cap exceeded)
```

## CLI reference

```
marshal init
marshal task list
marshal task create --slug <slug> --title <title> [--spec <markdown> | --spec-file <path>]
marshal task show <slug>
marshal task ready <slug>
marshal task freeze <slug>
marshal task transition <slug> <state>
marshal worktree create --task <slug>
marshal worktree destroy --task <slug>
marshal daemon run-once
marshal daemon start [--interval <ms>]
```

## Development

```sh
pnpm install
pnpm run build        # tsc + copy schema
pnpm run check        # type-check (no emit)
pnpm run test         # vitest
```

Pre-commit staged checks: `vp staged`.

Architecture decisions are recorded in [`docs/adr/`](docs/adr/).
