# ADR-001: Node Backend and Embedded React Frontend

## Status

Accepted — 2026-07-06

## Context

`docs/PROJECT.md` originally described the headless core daemon as a Rust binary distributed via `cargo install` / `brew` / `curl-install`. Before implementation, we needed to confirm the concrete runtime stack, distribution model, agent client, builder isolation, and frontend delivery strategy.

## Decisions

1. **Daemon runtime: Node.js**
   - The backend is implemented in Node.js, not Rust.
   - This replaces the Rust-daemon plan in `docs/PROJECT.md` §3.1.

2. **Distribution: npm package**
   - Published as an npm library/package (e.g. `npm i -g sataycat/marshal`).
   - Users install globally and run the CLI; no standalone binary or brew formula for M0.

3. **Agent client: ACPX first pass**
   - We use ACPX as the first ACP client, wrapped behind the internal anti-corruption adapter interface defined in `docs/PROJECT.md` §4.
   - Direct ACP JSON-RPC remains the fallback if ACPX churns.

4. **Builder isolation: bare host for M0**
   - The builder agent runs directly on the host with a permissive profile for the first vertical slice.
   - Containerized / devcontainer worktree isolation is deferred to a second pass.

5. **Frontend: embedded React SPA**
   - The React web board is built as a SPA and served statically from the Node backend.
   - A single port serves both the API and the UI.

## Consequences

- Faster iteration in M0: Node + npm matches the existing toolchain and avoids a Rust rewrite.
- Distribution is simpler for JavaScript users but requires Node to be pre-installed.
- Security risk is accepted for M0 because the builder runs on the host; this must be revisited before any multi-tenant or auto-merge usage.
- The backend is responsible for bundling and serving the frontend, which keeps deployment simple (one process, one port).

## Related

- `docs/PROJECT.md` §3.1 (daemon description) is now superseded by this ADR.
