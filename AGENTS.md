# Project overview

Marshal is a local-first, agent-agnostic coding-agent orchestrator ("software factory" loop). A human authors a spec, a coding agent (the "builder") autonomously implements it in an isolated git worktree, a different agent (the "validator") runs the verification gate, and the human reviews and merges.

## Session start

Read `docs/ARCHITECTURE.md` first. It is the consolidated reference for what the system is today: state machine, HTTP/WS API, worktree model, agent layer, build/validate flow, retry routing, onboarding preflight, and the file/module map.

Read `docs/PROJECT.md` for the design tenets, vision, and rationale. It answers _why_ the system is shaped the way it is; `ARCHITECTURE.md` answers _what_ and _where_.

`marshal init` is non-interactive: it checks prerequisites, writes `~/.marshal/config.json` with structured direct ACP command defaults, and initializes repo state. String role entries and ACPX are no longer supported. Agent verification is `marshal doctor`'s job (zero-cost direct ACP initialize + `session/new`).

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

Run verification commands sequentially, never in parallel: `pnpm install` (after pull) → `pnpm run check` → `pnpm run test` → any extra `pnpm run …` scripts before finishing. For the aggregate checks, run `pnpm run check:all` first and only start `pnpm run test:all` after it completes.

## Bundle analysis

- `pnpm run analyze` — rebuilds with `ANALYZE=1` to emit `web/dist/stats.html` (a rollup-plugin-visualizer treemap) for manual triage when a chunk surprises. Not a production-graph dep.

Before adding a non-trivial new dependency to `web/`, check its bundle cost with `pnpm run analyze`, keep heavy libraries such as `marked` and CodeMirror out of the initial chunk, and prefer dynamic `import()` at point of use.

## Testing

Always write tests for new functionality and bug fixes wherever possible. Running `pnpm run test` should stay green.

**Do NOT test the frontend.** Visual / component-appearance / "did the right thing render" tests for React components under `web/` are a waste of time and tokens. The shadcn/Base UI primitives, the Tailwind utility classes, and the DOM environment are somebody else's problem; we own the wiring. Pure logic that lives in `web/src/**/*.ts` (reducers, parsers, helpers, route tables, markdown rendering, time formatting, etc.) is fair game — it's the same kind of testable unit code as the Node side and lives next to it in `.test.ts` files. Anything that needs a DOM (jsdom / happy-dom / @testing-library/react) is out: skip the test, ship the component, and let the human-testing guide and the daemon end-to-end flow catch visual regressions.
