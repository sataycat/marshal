# ADR-002: Worktree Isolation Model

## Status

Accepted — 2026-07-07

## Context

`docs/M0-VERTICAL-SLICES.md` defines Slice 2 as the Worktree Manager: Marshal must create and destroy isolated git worktrees for tasks. ADR-001 accepted bare-host isolation for M0, so the git worktree is the primary isolation boundary between the source checkout, the builder, and the validator.

The open question was how to handle files that git does not track—especially dependencies (`node_modules`), local config (`.env`), and build artifacts—when a new worktree is created. Three comparable tools have converged on the same pattern.

## Prior art

All three tools use standard git worktrees and treat each worktree as a **fresh checkout of tracked files only**:

- **Conductor** uses `.worktreeinclude` (or `file_include_globs` in `.conductor/settings.toml`) to copy selected gitignored files into a new workspace, and a `scripts.setup` hook to install dependencies. It explicitly warns against copying `node_modules`, `.next`, `dist`, `target`, etc.
- **Codex** uses `.worktreeinclude` at the repo root to copy ignored files like `.env` into Codex-managed worktrees, and "Local environment" setup scripts in `.codex/` to run `npm install`.
- **Paseo** uses `paseo.json` → `worktree.setup` to run `npm ci` after worktree creation, and exposes `$PASEO_SOURCE_CHECKOUT_PATH` so setup scripts can copy local config from the original checkout.

None of them share `node_modules` or build-output directories between worktrees. They reinstall per worktree and rely on the package-manager’s global store/cache for efficiency.

## Decision

Marshal adopts the same two-layer model:

1. **`.worktreeinclude`** at the repo root — a gitignored-file allow-list using `.gitignore` syntax. Marshal copies matching ignored files from the source checkout into a new worktree. Tracked files are already present and are not copied. Source symlinks are skipped; existing files in the worktree are not overwritten.
2. **Setup script** — a user-configurable shell command run once after worktree creation, with the worktree as `cwd`. Configuration lives in `marshal.json` (repo root) under `worktree.setup`.

Additional rules:

- **No shared `node_modules` by default.** Each worktree installs its own dependencies from the lockfile. The setup script is responsible for this, e.g. `pnpm install`.
- **No copying of dependency/build directories.** `.worktreeinclude` patterns that match `node_modules`, `.next`, `dist`, `target`, `build`, `coverage`, or `.pnpm-store` are ignored with a warning.
- **Environment variables exposed to setup scripts:**
  - `MARSHAL_SOURCE_CHECKOUT_PATH` — absolute path to the original repo checkout.
  - `MARSHAL_WORKTREE_PATH` — absolute path to the new worktree.
  - `MARSHAL_TASK_SLUG` — the task slug.
  - `MARSHAL_BRANCH_NAME` — the worktree’s branch name.
- **Worktree location:** centralized under `~/.marshal/worktrees/<repo-hash>/<slug>-<descriptor>/`, where `<repo-hash>` is the first 8 characters of the SHA-256 of the source checkout path. The root is configurable via `worktree.root` in `~/.marshal/config.json`.
- **Branch name:** `marshal/task/<slug>-<descriptor>`, based on `HEAD` of the source checkout.
- **Descriptor:** a short memorable identifier in the style of Paseo/Conductor/Codex worktree slugs, composed of an adjective and a noun (e.g. `crimson-fox`). It is derived deterministically from the task slug so the same task gets the same descriptor; if a collision occurs, a numeric suffix is appended.
- **Cleanup:** `marshal worktree destroy --task <slug>` removes the worktree directory and the branch.

## Consequences

- Aligns Marshal with the dominant pattern in the category, reducing surprise for users coming from Conductor, Paseo, or Codex.
- Keeps Slice 2 small: the manager only creates/destroys worktrees and runs one optional setup script; dependency installation is delegated to the user’s existing toolchain.
- Avoids stale-state and lockfile-drift bugs that come from sharing `node_modules` between branches.
- Accepts the disk-space cost of per-worktree dependencies, mitigated by package-manager caches.
- Requires a small built-in word list and a gitignore-style matcher (`ignore` package) to implement `.worktreeinclude`.

## Related

- `docs/adr/ADR-001-node-backend-and-embedded-react.md` accepted bare-host isolation for M0.
- `docs/M0-VERTICAL-SLICES.md` Slice 2 implements this ADR.
