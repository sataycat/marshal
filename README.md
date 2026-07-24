# Marshal

A local-first, agent-agnostic coding-agent orchestrator built around a build-verify-review loop: you author the spec, an agent builds autonomously in an isolated git worktree, a different agent runs the verification gate, and you review and merge.

See [`docs/PROJECT.md`](docs/PROJECT.md) for the design tenets and vision, and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the consolidated reference (state machine, HTTP/WS API, agent layer, retry routing, onboarding, security).

## Requirements

- **Node.js ≥ 18** (ES2022).
- **git**.
- **A C++ toolchain** (`python3`, `make`, `g++` or `clang`) for `better-sqlite3`'s native build. Prebuilt binaries cover common platforms; the long tail needs the toolchain.
- **ACP agent commands.** Marshal connects directly through the official ACP SDK.
- **A browser.** Agents are discovered, installed, authenticated, and assigned from the web application; Marshal never requires hand-written role commands.

## Install

```sh
npm i -g sataycat/marshal
```

This installs the `marshal` binary on PATH. Start the daemon, then complete setup in the browser:

```sh
marshal start
# open http://127.0.0.1:7433/ and register your repository
```

Diagnostics, installation, authentication, readiness, and workflow assignment are browser flows under **Diagnostics**, **Agents**, and **Workflows**.

## Quickstart

```sh
# 1. Start Marshal and open the browser.
marshal start
# 2. Register a repository, install/authenticate a ready agent, and create a workflow profile.
# 3. Author, freeze, build, validate, review, and merge from the browser.
```

The daemon's HTTP + WebSocket API is at `http://127.0.0.1:7433/` (the port is configurable). The web board (a React SPA) is served from the same origin.

## State machine

```
backlog -> ready -> building -> validating -> review -> done
                     ^  |          ^  |
                     |  |          |  +---> building (retry, up to maxRetries)
                     |  |          |        +-> review (cap exceeded)
                     |  |          +-> backlog (Send Back)
                     |  +-> ready (re-queue), backlog (re-author)
                     +----- (human-driven escape hatches; reset retry state)
```

See [`docs/ARCHITECTURE.md` §0.1](docs/ARCHITECTURE.md#01-task-state-machine) and §2.2 for the full table and the escape-hatch semantics.

## CLI reference

```
marshal start [--interval <ms>] [--port <port>] [--host <addr>] [--lan] [--password <password>]
marshal stop
marshal status
```

`init`, `doctor`, `task`, and `worktree` are hidden development/recovery commands retained only for pre-browser state recovery. They are not required or supported for normal product use.

`marshal start` exposes the HTTP + WebSocket API on the daemon port. Use `marshal start --help` for the full flag list. LAN access requires a UI password, for example `marshal start --lan --password <password>`.

### Remote deployment

For a VPS or LAN deployment, prefer an environment variable or secret manager over a password command argument:

```sh
MARSHAL_UI_PASSWORD='use-a-long-random-password' marshal start --lan --port 7433
```

Marshal serves HTTP and requires the browser password session for API and WebSocket access. Do not publish the plain-HTTP listener directly to the public internet. Put it behind HTTPS or expose it only through a private VPN such as Tailscale or WireGuard. A reverse proxy must forward `/ws` as a WebSocket upgrade and set `X-Forwarded-Proto: https`; configure `daemon.trustedProxy: true` only when the daemon is reachable exclusively through that trusted proxy. Configure any additional browser origins with `daemon.trustedOrigins`.

Authentication protects the control plane but does not sandbox ACP agents. Run the daemon with an appropriately restricted OS account and use an explicit process/container/VM isolation policy for untrusted or unattended agent work.

### Storage, backup, and reset

`MARSHAL_HOME` is Marshal's complete persistence boundary. It defaults to
`~/.marshal`; set it to a mounted persistent volume for a VPS or container:

```sh
MARSHAL_HOME=/var/lib/marshal marshal start
```

Back up and restore the whole directory, including `marshal.db`, namespace
files, credentials, installations, and lifecycle metadata. For a consistent
backup, stop the daemon first or use SQLite's supported online backup API;
copying a live `marshal.db` and its WAL/SHM files independently is not a
reliable snapshot. Restore with the daemon stopped, then start it and review
Diagnostics.

To reset a development installation, stop Marshal and remove or replace the
entire `MARSHAL_HOME`; the next start creates a fresh database. Never delete a
registered source checkout to reset Marshal. Pre-1.0 releases used a split
layout (`machine.db` and repository `.marshal/state.db`); that layout is not
imported or scanned. Preserve any source configuration separately, remove the
old Marshal home, and reconnect repositories in the browser.

## Configuration

### Browser-owned configuration

Normal setup does not use `~/.marshal/config.json`, direct executable defaults, or role command configuration. The browser persists repositories, pinned installations, readiness/authentication state, and workflow assignments in daemon-owned storage.

### Optional per-repo (`marshal.json`)

```jsonc
{
  "worktree": {
    "setup": "pnpm install", // shell command run after each worktree is created
  },
}
```

A `.worktreeinclude` file in the repo root (gitignore syntax) lists gitignored files to copy into worktrees (e.g. `.env.local`).

## Development

```sh
pnpm install
pnpm run build        # tsc + copy schema
pnpm run check        # type-check (no emit)
pnpm run test         # vitest
```

Pre-commit staged checks: `vp staged`.

## Web board (dev workflow)

The web board is a Vite + React SPA in `web/`. The daemon serves the built bundle from `web/dist/` in production and proxies the API/WS to itself in dev.

```sh
pnpm dev                 # build the daemon, then run the daemon and Vite in parallel
```

The combined development command serves the API and WebSocket at `http://127.0.0.1:7433` and the Vite web app at `http://localhost:5173`. Opening the daemon URL during development redirects browser routes to Vite, so either URL reaches the hot-reloading application.

To run the processes separately:

```sh
pnpm run build:web    # build the SPA into web/dist/
pnpm --filter marshal-web run dev   # Vite dev server with proxy to the daemon
```

If `web/dist/` has not been built, `GET /` returns a 404 explaining the bundle is missing; the daemon keeps running and the API/WebSocket stay available. See [`docs/ARCHITECTURE.md` §11](docs/ARCHITECTURE.md#11-frontend-web).
