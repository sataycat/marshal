# Marshal

A local-first, agent-agnostic coding-agent orchestrator built around a build-verify-review loop: you author the spec, an agent builds autonomously in an isolated git worktree, a different agent runs the verification gate, and you review and merge.

See [`docs/PROJECT.md`](docs/PROJECT.md) for the design tenets and vision, and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the consolidated reference (state machine, HTTP/WS API, agent layer, retry routing, onboarding, security).

## Requirements

- **Node.js ≥ 18** (ES2022).
- **git**.
- **A C++ toolchain** (`python3`, `make`, `g++` or `clang`) for `better-sqlite3`'s native build. Prebuilt binaries cover common platforms; the long tail needs the toolchain.
- **[acpx](https://github.com/openclaw/acpx) on PATH** — the ACP client Marshal shells out to. Pin: `>=0.12.0 <0.13.0`.
- **A builder agent and a validator agent reachable through ACPX.** Defaults: `opencode` (builder) and `pi` (validator). Any ACP-compatible agent works — see the [acpx agent registry](https://acpx.sh/agents.html).

## Install

```sh
npm i -g sataycat/marshal
```

This installs the `marshal` binary on PATH. Then onboard a repo:

```sh
cd your-repo
marshal init
```

`marshal init` is non-interactive. It checks system prereqs and acpx, writes `~/.marshal/config.json` (with the default `opencode` / `pi` / `opencode` role assignments), and creates `.marshal/` for per-repo state. If acpx is missing it prints the install command and halts — it does not run installs itself.

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
  "acpx": { "bin": "acpx", "version": ">=0.12.0 <0.13.0" },
  "agents": {
    "builder": "opencode", // any ACPX agent id
    "validator": "pi", // any ACPX agent id
    "specAuthor": "opencode",
  },
  "policy": { "maxRetries": 2 },
  "daemon": { "host": "127.0.0.1", "port": 7433 },
}
```

Any agent in the [acpx registry](https://acpx.sh/agents.html) works — `claude`, `codex`, `gemini`, `kimi`, etc. The defaults are written by `marshal init`; edit the file to override. See [`docs/ARCHITECTURE.md` §0.6](docs/ARCHITECTURE.md#06-config-keys) for the full key reference.

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
