# Marshal

A local-first, agent-agnostic coding-agent orchestrator built around a build-verify-review loop: you author the spec, an agent builds autonomously in an isolated git worktree, a different agent runs the verification gate, and you review and merge.

See [`docs/PROJECT.md`](docs/PROJECT.md) for the design tenets and vision, and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the consolidated reference (state machine, HTTP/WS API, agent layer, retry routing, onboarding, security).

## Requirements

- **Node.js ≥ 18** (ES2022).
- **git**.
- **A C++ toolchain** (`python3`, `make`, `g++` or `clang`) for `better-sqlite3`'s native build. Prebuilt binaries cover common platforms; the long tail needs the toolchain.
- **ACP agent commands.** Marshal connects directly through the official ACP SDK.
- **A builder agent and a validator agent reachable through their configured commands.** Generated defaults use `npx -y opencode-ai acp` (builder/spec author) and `npx -y pi-acp` (validator).

## Install

```sh
npm i -g sataycat/marshal
```

This installs the `marshal` binary on PATH. Then onboard a repo:

```sh
cd your-repo
marshal init
```

`marshal init` is non-interactive. It checks system prerequisites, writes `~/.marshal/config.json` with structured direct ACP commands, and creates `.marshal/` for per-repo state. A legacy config containing string role IDs is migrated to the generated direct defaults; customize those commands afterward if needed.

To verify a setup without mutating anything:

```sh
marshal doctor
```

## Quickstart

```sh
# 1. Create a task in the backlog.
marshal task create --slug add-feature --title "Add the feature" --spec-file ./spec.md

# 2. Freeze the spec and move to ready (creates the worktree + commits the spec).
marshal task ready add-feature

# 3. Run the loop.
marshal daemon start              # long-running poll, every 5s
# or
marshal daemon run-once           # one cycle, then exit

# 4. When the task reaches `review`, inspect and merge.
marshal task show add-feature
# In the web board, open http://127.0.0.1:7433/, click "Approve & Merge"
# Or via API:
curl -X POST http://127.0.0.1:7433/api/tasks/add-feature/merge
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
marshal init
marshal doctor
marshal task list
marshal task create   --slug <slug> --title <title> [--spec <md> | --spec-file <path>]
marshal task show     <slug>
marshal task ready    <slug>
marshal task freeze   <slug>             # re-freeze after editing the spec
marshal task transition <slug> <state>   # manual transition (incl. escape hatches)
marshal worktree create  --task <slug>
marshal worktree destroy --task <slug>
marshal daemon run-once
marshal daemon start [--interval <ms>] [--port <port>] [--host <addr>]
```

`marshal daemon start` exposes the HTTP + WebSocket API on the daemon port. `marshal daemon start --help` for the full flag list.

## Configuration

### Global (`~/.marshal/config.json`)

```jsonc
{
  "agents": {
    "builder": {
      "id": "opencode",
      "command": "npx",
      "args": ["-y", "opencode-ai", "acp"],
    },
    "validator": {
      "id": "pi",
      "command": "npx",
      "args": ["-y", "pi-acp"],
    },
    "specAuthor": {
      "id": "opencode",
      "command": "npx",
      "args": ["-y", "opencode-ai", "acp"],
    },
  },
  "policy": { "maxRetries": 2 },
  "daemon": { "host": "127.0.0.1", "port": 7433 },
}
```

Any ACP-compatible executable can be used by configuring its command directly. The defaults are written by `marshal init`; edit the file to override:

```json
{
  "agents": {
    "builder": {
      "id": "opencode",
      "command": "npx",
      "args": ["-y", "opencode-ai", "acp"]
    },
    "validator": {
      "id": "codex",
      "command": "npx",
      "args": ["-y", "@agentclientprotocol/codex-acp"]
    }
  }
}
```

Commands are executed directly without a shell. Optional `env` values are merged into the child process environment. String agent IDs are not supported.

### Per-repo (`marshal.json`)

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
pnpm run build:web    # build the SPA into web/dist/
pnpm --filter marshal-web run dev   # Vite dev server with proxy to the daemon
```

If `web/dist/` has not been built, `GET /` returns a 404 explaining the bundle is missing; the daemon keeps running and the API/WebSocket stay available. See [`docs/ARCHITECTURE.md` §11](docs/ARCHITECTURE.md#11-frontend-web).
