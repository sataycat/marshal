# ADR-010: HTTP Framework for the Daemon API

## Status

Accepted — 2026-07-09

Implements `docs/M1-VERTICAL-SLICES.md` Slice 1 (HTTP API Server Skeleton).

## Context

M1 turns Marshal from a CLI-only tool into a daemon with a shared API contract for the web board, future TUI, and existing CLI peer clients. `docs/PROJECT.md` §3.1 already requires the daemon to own an HTTP + WebSocket API, bind one process per repo, and write `.marshal/daemon.port` so clients can discover the active process.

Slice 1 needs only a narrow surface: bind `127.0.0.1`, expose `GET /api/health`, run beside the existing orchestrator poll loop, shut down gracefully, and remove the port file on clean exit. But the framework choice becomes the foundation for later M1 slices: Task CRUD, run history, static SPA serving, and WebSocket upgrade handling.

The options considered:

- **Hono** — small dependency, clean route composition, good TypeScript ergonomics, can run on Node through `@hono/node-server`.
- **Fastify** — mature Node server with strong plugin ecosystem and validation hooks, but heavier than the current M1 surface requires.
- **Raw `node:http`** — no framework dependency, but routing, validation, error envelopes, static serving, and middleware become hand-rolled quickly.

## Decisions

### 1. Use Hono for HTTP routing

The daemon API will use Hono for HTTP routes and middleware. Hono is small enough for the local-first daemon, keeps handlers readable, and avoids prematurely adopting Fastify's larger plugin model before Marshal needs it.

The initial dependency set should include Hono plus the Node adapter:

```text
hono
@hono/node-server
```

Hono owns HTTP request routing for:

- `GET /api/health`
- later `/api/tasks`, `/api/runs`, and static web routes
- common JSON responses and error envelopes

### 2. Keep one Node HTTP server per repo daemon

The daemon will create one underlying Node HTTP server for the repo process, matching `docs/PROJECT.md` §3.1's "one daemon process per repo" model. Hono attaches to that server; later WebSocket upgrade handling attaches to the same server.

This keeps a single bound port for all daemon surfaces:

- HTTP API under `/api/*`
- WebSocket endpoint at `/ws`
- SPA shell at `/`

### 3. Bind localhost by default and reject broad exposure for M1

The daemon binds `127.0.0.1` by default. The port defaults to `7433`, with overrides from `~/.marshal/config.json` at `daemon.port` and a `marshal daemon start --port` flag.

M1 does not add authentication. If a user attempts to bind `0.0.0.0` or another non-loopback address, the daemon should not silently comply. The startup path must warn clearly and continue only when the caller explicitly requested that address. Any non-localhost exposure remains unsupported without an authenticated tunnel or future auth layer, per `docs/PROJECT.md` §8.

### 4. Write `.marshal/daemon.port` after the server is actually listening

The daemon writes `.marshal/daemon.port` only after the server has successfully bound. The file contains the concrete bound port, not merely the requested port, so clients can discover the daemon even if a future config allows ephemeral or fallback ports.

On clean shutdown, the daemon removes `.marshal/daemon.port`. On startup, stale files are ignored unless the discovered process is actually reachable through `GET /api/health`.

### 5. Graceful shutdown is part of the server contract

On `SIGINT` or `SIGTERM`, the daemon stops accepting new HTTP connections, lets in-flight requests finish, removes `.marshal/daemon.port`, and then exits. The existing orchestrator loop should receive the same shutdown signal instead of being killed independently.

### 6. WebSockets are not routed through Hono in M1

Hono handles HTTP routes. Slice 3's WebSocket endpoint will use a Node WebSocket library attached to the same underlying server's `upgrade` event. This avoids contorting Hono into WebSocket ownership while preserving one port and one server lifecycle.

## Consequences

- The HTTP API has a small, typed routing layer without hand-rolled routing infrastructure.
- Fastify's richer validation/plugin ecosystem is deferred until there is a demonstrated need.
- WebSocket ownership is explicit: same server and port, separate upgrade handler.
- The daemon's process model stays aligned with `docs/PROJECT.md`: one repo daemon, one port file, thin clients.
- Adding dependencies in Slice 1 is intentional and should be reflected in `package.json` when implemented.

## Open questions (deferred)

- **Authenticated non-localhost access.** Token auth or tunnel-aware auth is deferred past the first M1 slices. Until then, localhost is the safe default.
- **Port fallback policy.** Slice 1 specifies a default and explicit override, not an automatic port range. Automatic fallback can be added later if daemon startup collisions become common.
- **Typed route schemas.** Slice 2 will define request validation for task APIs; if hand-written validation becomes noisy, a schema library can be reconsidered then.

## Related

- `docs/M1-VERTICAL-SLICES.md` Slice 1 — HTTP API Server Skeleton.
- `docs/PROJECT.md` §3.1 — daemon process model and `.marshal/daemon.port`.
- `docs/PROJECT.md` §8 — daemon API trust boundary.

