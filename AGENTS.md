# Project overview

Marshal is a local-first, agent-agnostic coding-agent orchestrator ("software factory" loop). A human authors a spec, a coding agent (the "builder") autonomously implements it in an isolated git worktree, a different agent (the "validator") runs the verification gate, and the human reviews and merges.

## Session start

Read `docs/ARCHITECTURE.md` first. It is the consolidated reference for what the system is today: state machine, HTTP/WS API, worktree model, agent layer, build/validate flow, retry routing, onboarding preflight, and the file/module map.

Read `docs/PROJECT.md` for the design tenets, vision, and rationale. It answers _why_ the system is shaped the way it is; `ARCHITECTURE.md` answers _what_ and _where_.

`marshal init` is non-interactive: it checks prerequisites and acpx, writes `~/.marshal/config.json` with `AGENT_ID_DEFAULTS`, and initializes repo state. If acpx is missing it prints the install command and halts. Agent verification is `marshal doctor`'s job (zero-cost session probe via `acpx <agent> sessions new` + `close`).

## Reference docs

- `docs/ARCHITECTURE.md` — consolidated reference (read first)
- `docs/PROJECT.md` — design tenets, vision, state machine narrative, milestone sequence
- `docs/HUMAN-TESTING-GUIDE.md` — manual QA guide

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

## Bundle budgets

`size-limit` enforces the per-chunk gzipped-JS budgets from ADR-0001a §3 (initial chunk ≤ 110 KB; route chunks have their own limits in `web/.size-limit.json`).

- `pnpm run size` — runs `size-limit` against the built `web/dist`; runs in CI and is wired into `pnpm run build:web`, so a budget breach fails the build. Fix the import or update the budget in `web/.size-limit.json` with rationale.
- `pnpm run analyze` — rebuilds with `ANALYZE=1` to emit `web/dist/stats.html` (a rollup-plugin-visualizer treemap) for manual triage when a chunk surprises. Not a production-graph dep.

Before adding a non-trivial new dependency to `web/`, check its bundle cost: run `pnpm run analyze` before and after, treat the CodeMirror chunk as its own lazy budget (never pull heavy libs into the initial chunk), and prefer dynamic `import()` at point of use. If the new dep would breach a budget in `web/.size-limit.json`, either lazy-split it, find a lighter alternative, or raise the budget with rationale in the PR.

## Testing

Always write tests for new functionality and bug fixes wherever possible. Running `pnpm run test` should stay green.
