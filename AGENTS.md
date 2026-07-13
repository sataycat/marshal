# Project overview

Marshal is a local-first, agent-agnostic coding-agent orchestrator ("software factory" loop). A human authors a spec, a coding agent (the "builder") autonomously implements it in an isolated git worktree, a different agent (the "validator") runs the verification gate, and the human reviews and merges.

## Session start

Read `docs/PROJECT.md` before starting any work. It defines the architecture, design tenets, state machine, and terminology (ACP, ACPX, Boundary gate, Builder, Validator, etc.).

When implementing features, also consult the relevant milestone file (`docs/M0-VERTICAL-SLICES.md`, `docs/M1-VERTICAL-SLICES.md`) and the applicable ADRs under `docs/adr/`.

`marshal init` is non-interactive: it checks prerequisites and acpx, writes `~/.marshal/config.json` with `AGENT_ID_DEFAULTS`, and initializes repo state. If acpx is missing it prints the install command and halts. Agent verification is `marshal doctor`'s job (zero-cost session probe via `acpx <agent> sessions new` + `close`).

## Reference docs

- `docs/PROJECT.md` — overall architecture, design tenets, state machine, milestone sequence
- `docs/M0-VERTICAL-SLICES.md` — M0 milestones (daemon + CLI + worktree + builder/validator loop)
- `docs/M1-VERTICAL-SLICES.md` — M1 milestones (HTTP API, WebSocket bus, web SPA, diff review, PRs, spec chat)
- `docs/adr/` — architecture decision records. When an ADR is completed/accepted, move it from `docs/adr/ADR-XXX.md` to `docs/adr/archived/ADR-XXX.md`. Proposed/working ADRs stay at `docs/adr/`.

# Toolchain

Use standard package-manager commands for development. The repo pins `pnpm@11.10.0` via `packageManager`.

- Install: `pnpm install`
- Build: `pnpm run build`
- Test: `pnpm run test`
- Type-check: `pnpm run check`
- Custom `package.json` scripts: `pnpm run <script>`

## Pre-commit hooks

Vite+ is still used only for staged pre-commit formatting and linting:

- Staged pre-commit checks: `vp staged`

Run `pnpm install` (after pull) → `pnpm run check && pnpm run test` → any extra `pnpm run …` scripts before finishing.

## Testing

Always write tests for new functionality and bug fixes wherever possible. Running `pnpm run test` should stay green.
