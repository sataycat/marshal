# Project overview

Marshal is a local-first, browser-based ACP client for software work. It discovers agents through the ACP Registry, installs and authenticates them, supervises ACP sessions, and uses the same installed-agent inventory for interactive repository threads and build-validate-review workflows.

Marshal is pre-1.0. Prefer the target architecture over compatibility with legacy direct-command role configuration, CLI onboarding, or agent-specific defaults.

## Session start

Read `docs/ARCHITECTURE.md` first. It is the canonical target architecture: daemon and web boundaries, ACP Registry integration, installation, authentication, sessions, permissions, repositories, and factory workflows.

Read `docs/PROJECT.md` for the product thesis, design tenets, primary experience, and delivery sequence. `PROJECT.md` explains why; `ARCHITECTURE.md` defines what.

The web application is the complete product interface. Normal agent discovery, installation, authentication, configuration, diagnostics, and workflow assignment must be designed for the web application and daemon API. The CLI is limited to starting, stopping, and inspecting the daemon; do not add product workflows to it.

## Architecture rules

- ACP is the only agent runtime contract. Do not add provider- or agent-specific adapters when standard ACP can express the behavior.
- The ACP Registry is the default catalog, not runtime truth. Validate and cache registry metadata, then install pinned local versions.
- Keep registry, installation, authentication, ACP runtime, repository, thread, and workflow concerns in separate modules.
- Threads and workflow runs both execute through the same ACP process/session supervisor.
- Builder, validator, and spec-author are workflow assignments of installed agents, not executable configuration types.
- Persist the resolved agent ID and version with every thread and run. Updates never rewrite history.
- Reflect negotiated ACP capabilities in the UI instead of assuming feature parity across agents.
- Installation, authentication, assignment, and unattended execution are separate trust transitions.
- ACP permissions are not a sandbox. Keep isolation policy explicit.
- Existing code that conflicts with these rules may be deleted or migrated without backward-compatibility layers unless persisted user data requires a concrete migration.

## Reference docs

- `docs/ARCHITECTURE.md` — canonical target architecture (read first)
- `docs/PROJECT.md` — product vision and design tenets
- `docs/HUMAN-TESTING-GUIDE.md` — manual QA guide; update it when product flows change

# Toolchain

Use standard package-manager commands for development. The repo pins `pnpm@11.10.0` via `packageManager`.

- Install: `pnpm install`
- Build: `pnpm run build`
- Test: `pnpm run test`
- Type-check: `pnpm run check`
- Custom `package.json` scripts: `pnpm run <script>`

## Pre-commit hooks

Vite+ is used only for staged pre-commit formatting and linting:

- Staged pre-commit checks: `vp staged`

Run verification commands sequentially, never in parallel: `pnpm install` after pulling, then `pnpm run check`, then `pnpm run test`, then any extra scripts. For aggregate checks, finish `pnpm run check:all` before starting `pnpm run test:all`.

## Bundle analysis

- `pnpm run analyze` rebuilds with `ANALYZE=1` and emits `web/dist/stats.html`.

Before adding a non-trivial frontend dependency, check its bundle cost. Keep heavy libraries out of the initial chunk and prefer dynamic imports at point of use.

## Testing

Write tests for new backend functionality and bug fixes wherever possible. Registry parsing, distribution selection, integrity verification, archive safety, authentication state, ACP session lifecycle, permission policy, durable operations, and workflow transitions are high-value test boundaries. Running `pnpm run test` should stay green.

Do not write visual or component-appearance tests for React components under `web/`. Pure logic in `web/src/**/*.ts` is appropriate for unit tests. Anything requiring jsdom, happy-dom, or React Testing Library should be covered through manual product testing and daemon end-to-end flows instead.
