# ADR-014: Frontend Build and Serve Strategy

## Status

Accepted — 2026-07-09

Implements `docs/M1-VERTICAL-SLICES.md` Slice 5 (Static SPA Shell & Board View).

## Context

M1 introduces Marshal's first web client: a Kanban board served by the local daemon. The client needs task CRUD, run history, and WebSocket events, but it does not need SSR, server actions, routing conventions, or a full meta-framework.

The daemon is already the source of truth and API boundary. The frontend should stay a thin client over HTTP and WebSocket.

## Decisions

### 1. Use plain Vite React, not a React meta-framework

The web board will be a plain React SPA built with Vite.

This keeps M1 small:

- no SSR runtime
- no framework-specific server integration
- fast local development
- static production output that the daemon can serve directly

Next.js, Remix, TanStack Start, and similar frameworks are deferred until the web client needs routing/data-loading behavior that a small SPA cannot provide.

### 2. Place the web app under `web/`

The frontend source lives in a top-level `web/` directory:

```text
web/
  index.html
  src/
  dist/
```

The root package remains the installable `marshal` CLI/daemon package. Web build scripts can be exposed from the root `package.json`, but the source stays separate enough that daemon code and browser code do not accidentally share Node-only imports.

### 3. Serve `web/dist/` from the daemon in production

The daemon serves static assets from `web/dist/`:

| Request                       | Behavior                        |
| ----------------------------- | ------------------------------- |
| `/api/*`                      | Hono API route.                 |
| `/ws`                         | WebSocket upgrade route.        |
| asset path under `/assets/*`  | Static file from `web/dist/`.   |
| `/` and unknown non-API paths | `web/dist/index.html` fallback. |

API and WebSocket routes take precedence over the SPA fallback. Missing static assets return `404`; unknown browser routes return `index.html` so the SPA can route internally if needed.

If `web/dist/index.html` is absent, `GET /` returns a clear `404` explaining that the web bundle has not been built. The daemon should not crash because a developer has not run the frontend build.

### 4. Use Vite dev server with a proxy during development

During development, Vite serves the SPA and proxies API/WebSocket traffic to the daemon:

```text
http://127.0.0.1:5173/       -> Vite dev server
/api/* and /ws               -> http://127.0.0.1:7433
```

The browser client uses same-origin relative URLs (`/api/tasks`, `/ws`) so no code changes are needed between dev and production.

### 5. Keep the browser client API-agnostic and reconnectable

The SPA initializes from `GET /api/tasks` or the WebSocket `connected` snapshot, then applies WebSocket updates from ADR-012. If the WebSocket disconnects, the client reconnects and accepts the new `connected` snapshot as truth.

The frontend does not keep its own durable state. Refreshing the page must reconstruct the board from daemon APIs.

### 6. M1 styling is functional, not a design system

Slice 5 optimizes for a usable board:

- Backlog, Ready, Building, Validating, Review, and Done columns.
- Cards show title, slug, and time-in-state.
- Card detail shows rendered spec markdown, status, retry count, and last failure.

No component library or CSS framework is required for M1. Adding one should be justified by concrete UI needs rather than by default.

## Consequences

- The daemon remains the only server process required in production.
- The frontend build is a static artifact, easy to package with the CLI later.
- Dev workflow stays fast through Vite while preserving same-origin production assumptions.
- The lack of SSR is intentional; the board is authenticated-by-localhost and not SEO/content driven.

## Open questions (deferred)

- **Packaging.** The exact npm packaging step for including `web/dist/` can be decided when release automation is added.
- **Component library.** M1 starts without one. Adopt a library only if diff rendering, modals, or accessibility requirements make hand-rolled components too costly.
- **Non-localhost access.** The SPA inherits the daemon API trust boundary from ADR-010. Exposing it through a tunnel requires authenticated access before it is supported.

## Related

- `docs/M1-VERTICAL-SLICES.md` Slice 5 — Static SPA Shell & Board View.
- `docs/adr/ADR-010-http-framework.md` — one daemon HTTP server and static route owner.
- `docs/adr/ADR-011-task-crud-api.md` — task data source.
- `docs/adr/ADR-012-websocket-event-bus.md` — live board updates.
