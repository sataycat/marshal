# ADR-003: Agent Adapter and ACPX Integration

## Status

Superseded in part by ADR-019 (open `AgentId`) and ADR-023 (ACPX-as-sole-substrate, no defaults). Decisions 2, 6, and 7 are retracted by ADR-023; Decisions 1, 3, 4, 5 stand.

Accepted — 2026-07-07

## Context

`docs/M0-VERTICAL-SLICES.md` Slice 4 requires an internal `Agent` interface and an ACPX adapter implementing it, so the daemon can spawn `opencode` (builder) and `pi` (validator) in a worktree and exchange a prompt/response through a stable interface with ACPX behind it.

`docs/PROJECT.md` §4 already fixed the anti-corruption stance: ACPX is alpha, sits behind one adapter, and direct ACP JSON-RPC is the fallback. `docs/adr/ADR-001-node-backend-and-embedded-react.md` decision #3 chose "ACPX first pass." Neither specifies the concrete interface, the invocation model, the session strategy, or the event shape — all of which Slice 4 needs. This ADR makes those decisions and records two places we deviate from PROJECT.md §4.

Two PROJECT.md open questions are also settled here:

- §11: "Do we adopt OpenClaw's gateway wholesale, or use ACPX standalone?" → **ACPX standalone.**
- §4: the `streamEvents(session)` method is folded into `prompt` (see Decision 1).

## Research: how ACPX and OpenClaw relate

ACPX (`openclaw/acpx`, npm package `acpx`, MIT, alpha, 2.9k stars, latest `0.12.0` as of 2026-07) is a **headless CLI client** for the [Agent Client Protocol](https://agentclientprotocol.com). It is a command-line tool, not a library: there is no documented stable programmatic API, so the only durable integration surface is the `acpx` binary and its stdout. Per its own CLI reference, `--format json --json-strict` emits **raw ACP JSON-RPC NDJSON** — one message per line — with an explicit "hard rule: no acpx-specific event envelope, no synthetic `type`/`stream` wrapper fields." (The README's earlier "stable envelope" example with `eventVersion`/`seq`/`stream`/`type` contradicts the CLI reference; we treat the CLI reference as authoritative and pin the version so the format cannot drift.)

Relevant ACPX behaviors, confirmed from `docs/CLI.md` and `skills/acpx/SKILL.md`:

- **Built-in agent registry** maps friendly names to adapter commands: `opencode` → `npx -y opencode-ai acp`, `pi` → `npx pi-acp`. ACPX auto-downloads the adapter via `npx` on first use; the underlying coding agent (opencode, pi) must be installed and authenticated by the user.
- **Sessions are scoped** by `(agentCommand, absoluteCwd, optionalName)` and stored under `~/.acpx/sessions/*.json`. `--cwd <dir>` sets the scope directory. This makes a per-worktree session trivial: set `--cwd` to the worktree path and builder/validator sessions can never collide.
- **`sessions ensure [--name <name>]`** is idempotent get-or-create for a scope — safe to call before every prompt in a script.
- **Prompt model**: `acpx <agent> -s <name> 'text'` resumes/creates the scoped session, streams the turn, and exits when the turn ends. `--no-wait` enqueues and returns; `cancel` sends cooperative ACP `session/cancel` via queue-owner IPC without tearing down the session. `exec` is one-shot (no saved session).
- **Permissions**: `--approve-all` / `--approve-reads` (default) / `--deny-all` are mutually exclusive. In a non-TTY, `--non-interactive-permissions deny` (default) or `fail` controls behavior. Headless runs require `--approve-all` because there is no TTY to approve prompts (PROJECT.md §8).
- **Output formats**: `text` (human), `json` (raw ACP NDJSON), `quiet` (final assistant text on stdout; one structured `[acpx] error:` line on stderr on failure). `--suppress-reads` redacts file bodies.
- **Exit codes**: `0` success, `1` agent/protocol error, `2` CLI usage, `3` timeout, `4` no session, `5` permission denied, `130` interrupted.
- **Controls useful to us**: `--timeout <seconds>`, `--ttl <seconds>` (queue-owner idle TTL), `--model <id>`, `--system-prompt` / `--append-system-prompt` (claude-agent-acp consumes it; other adapters ignore), `--allowed-tools`, `--max-turns`, `--prompt-retries`, `--no-terminal` (do not advertise terminal capability — good for review-only runs).
- **Auth**: ambient provider env vars (`OPENAI_API_KEY`, etc.) are inherited by child agents; ACP `authenticate` handshakes use `ACPX_AUTH_<METHOD_ID>` env vars or `auth` config entries. For M0 we rely on ambient env vars plus each agent's own config.
- **Crash reconnect**: if a saved session PID is dead, ACPX respawns the agent and tries `session/resume` then `session/load`, falling back to `session/new`.

OpenClaw (`openclaw/openclaw`) is a **separate, much larger system**: a personal-assistant "Gateway" daemon with its own channels (WhatsApp/Telegram/Slack/...), multi-agent routing, sandboxing (`agents.defaults.sandbox.mode: "non-main"` with Docker/SSH/OpenShell backends), sessions (`sessions_list/history/send/spawn`), skills, and a native `openclaw acp` ACP bridge. ACPX's built-in `openclaw` agent token simply wraps `openclaw acp`. In other words, **OpenClaw is one agent behind ACPX, not the substrate.** Adopting the OpenClaw gateway would couple Marshal to a second large, fast-moving system in order to reuse features (sandboxing, multi-agent routing) that M0 does not need and that ADR-001 already defers. Marshal therefore uses ACPX standalone and treats `openclaw` as just another agent ID, not a dependency.

## Decisions

### 1. Internal `Agent` interface (deviates from PROJECT.md §4)

```ts
export type AgentId = "opencode" | "pi";
// Extensible: unknown ids are rejected in M0; the registry is a plain map so
// adding claude/codex/gemini/kimi later is a one-line change.

export interface AgentSession {
  agentId: AgentId;
  cwd: string; // absolute worktree path; ACPX session scope
  name: string; // ACPX named-session id, e.g. "marshal-<slug>-builder"
  recordId?: string; // acpx record id from `sessions ensure` JSON, for diagnostics
}

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; title: string; status?: string; output?: string }
  | { type: "permission"; tool: string; granted: boolean }
  | { type: "log"; stream: "stdout" | "stderr"; text: string }
  | { type: "done"; stopReason: string }
  | { type: "error"; message: string; code?: number };

export interface SpawnOptions {
  permissionMode?: "approve-all" | "approve-reads" | "deny-all"; // default "approve-all" for M0
  timeoutSeconds?: number; // per-prompt ceiling, default 1800
  model?: string;
  systemPrompt?: string; // forwarded via --system-prompt (claude-family only)
  extraArgs?: string[]; // escape hatch (--allowed-tools, --max-turns, etc.)
}

export interface PromptOptions extends SpawnOptions {
  noWait?: boolean;
}

export interface Agent {
  spawn(cwd: string, agentId: AgentId, opts?: SpawnOptions): Promise<AgentSession>;
  prompt(session: AgentSession, text: string, opts?: PromptOptions): AsyncIterable<AgentEvent>;
  cancel(session: AgentSession): Promise<void>;
  close(session: AgentSession): Promise<void>;
}
```

**Deviation from PROJECT.md §4:** `streamEvents(session)` is removed and events are returned from `prompt` as an `AsyncIterable`. Rationale: ACPX runs one streaming subprocess per prompt; a separate `streamEvents(session)` would have nothing to read between prompts and would have to race the prompt call. The prompt-call-is-the-stream model matches the substrate and is simpler for callers. PROJECT.md §4 is updated accordingly.

`cancel` and `close` are included even though Slice 4's scope lists only `spawn`/`prompt`/`close`. PROJECT.md §4 lists `cancel`; implementing it now is cheap (it is one `acpx cancel` call) and Slice 7 (retry routing) needs it. Slice 4 delivers `spawn`, `prompt`, `close`, and `cancel`; `cancel` may be lightly tested in Slice 4 and exercised in Slice 7.

### 2. Invocation model: shell out to the `acpx` binary, parse NDJSON

The adapter spawns the `acpx` CLI as a child process (Node `child_process.spawn`). It does **not** import `acpx` as a Node library — ACPX ships a CLI with no stable programmatic API, and importing internals would couple the core to alpha internals, defeating the anti-corruption layer. The contract is: `acpx` on PATH, NDJSON on stdout.

- `spawn`: `acpx <agent> sessions ensure --name <name> --cwd <cwd> --format json --json-strict`, parse the JSON session record to capture `recordId`.
- `prompt`: `acpx <agent> -s <name> --cwd <cwd> --format json --json-strict [opts] '<text>'`, read stdout line-by-line, parse each line as a JSON-RPC message, map to `AgentEvent`, yield through an `AsyncGenerator`. stderr is tee'd into the event stream as `{type:"log", stream:"stderr"}`. The generator ends when the request `result` with `stopReason` arrives or the process exits.
- `cancel`: `acpx <agent> cancel -s <name> --cwd <cwd>`.
- `close`: `acpx <agent> sessions close <name> --cwd <cwd>`.

Prompt text is passed via `--file -` (stdin) rather than a positional argv to avoid shell-escaping and argv-length limits on large specs.

### 3. Session strategy: persistent named sessions, cwd-scoped to the worktree

Use persistent ACPX sessions (`sessions ensure` + named `-s`), not one-shot `exec`.

- **Scope key**: `(agentCommand, cwd=<worktree>, name=<role>)`. The worktree path is already unique per task, so builder and validator sessions never collide even at the same agent. `name` is `marshal-<slug>-<role>` (role ∈ `builder` | `validator`) for clarity and to allow parallel streams in later slices.
- **Why persistent over `exec`**: gives crash-reconnect (an ACPX feature), turn history for diagnostics, and multi-turn follow-ups for Slice 7's bounce-back without changing the interface. The cost is one `close` per session and occasional `prune`; acceptable.
- **Lifecycle**: `spawn` = ensure; `close` = soft-close (record retained). Slice 4 does not `prune`; that is a daemon housekeeping task for a later slice.

### 4. Permission default: `--approve-all` for M0

Headless runs have no TTY to approve prompts (PROJECT.md §8). The adapter passes `--approve-all --non-interactive-permissions fail` by default. `fail` is belt-and-braces: with `--approve-all` no prompt should reach the non-interactive path, but if one does we fail fast rather than silently deny.

This is the security risk ADR-001 explicitly accepted for M0 (bare-host isolation). The permission mode is a `SpawnOptions` field so the validator (Slice 6) can tighten it (e.g. `--deny-all --no-terminal` for a review-only posture, or a `--policy` allowlist for test execution) without changing the adapter. The adapter's `extraArgs` option forwards arbitrary ACPX flags for finer control.

### 5. Event mapping: ACP `session/update` → typed `AgentEvent`

The adapter parses the ACP NDJSON stream per the CLI reference's "hard rule" (raw JSON-RPC, no acpx envelope). Mapping:

- `session/update` with `sessionUpdate: "agent_message_chunk"` and `content.type: "text"` → `{type:"text", text}`.
- `session/update` with thinking/tool variants → `{type:"thinking"}` / `{type:"tool"}`. The exact ACP `sessionUpdate` enumeration is fixed at implementation time against the pinned ACPX version; **unknown variants pass through as `{type:"log", stream:"stdout", text: <raw json line>}`** so the adapter never drops data when ACP adds a new update kind.
- The request `result` with `stopReason` → `{type:"done", stopReason}` (e.g. `end_turn`, `cancelled`). The generator then ends.
- `session/request_permission` → `{type:"permission", tool, granted:true}` (auto-approved under `--approve-all`).
- Process exit with non-zero code and no `done` → `{type:"error", message, code}` mapped from ACPX exit codes (3→timeout, 4→no-session, 5→permission-denied, 130→interrupted, 1→agent error).

### 6. Agent ID registry and ACPX presence

- A `Record<AgentId, string>` maps `opencode`→`"opencode"`, `pi`→`"pi"` (the ACPX positional agent tokens). Unknown ids throw a clear error in M0.
- `spawn` first checks the `acpx` binary is on PATH (path configurable via `~/.marshal/config.json` → `acpx.bin`). If missing, throw: `acpx is not installed. Install with \`npm i -g acpx@latest\` and see docs/adr/ADR-003.md.`
- ACPX version is pinned via `acpx.version` in global config (e.g. `">=0.12.0 <0.13.0"`). `spawn` runs `acpx --version` once and **warns** on mismatch (does not hard-fail — ACPX is alpha and a minor drift should not block a run, but a major bump must be visible). Auto-install is out of scope for M0.
- Agent prerequisites (opencode/pi installed and authenticated) are the user's responsibility; the adapter surfaces ACP initialize/auth failures from stderr as `{type:"error"}` with the agent's message.

### 7. Timeouts and cancellation

- `--timeout <seconds>` is forwarded per prompt (default 1800s builder, configurable). On ACPX exit code 3, the adapter emits `{type:"done", stopReason:"timeout"}` then `{type:"error", code:3}` and the generator ends.
- `cancel(session)` runs `acpx <agent> cancel -s <name> --cwd <cwd>`; it does not kill a child process directly — it asks ACPX's queue owner to send ACP `session/cancel` cooperatively, matching ACPX's design. If a `prompt` generator is still running it observes the resulting `stopReason: "cancelled"` and ends.

## Consequences

- **Anti-corruption boundary is concrete**: the core depends on the `Agent` interface and `AgentEvent` union only. ACPX churn is contained to one adapter file. If ACPX breaks its NDJSON format or dies, a direct-ACP adapter implementing the same interface replaces it (PROJECT.md §4 fallback).
- **PROJECT.md §4 is updated**: `streamEvents(session)` is removed; events stream from `prompt`. PROJECT.md §11 is resolved: ACPX standalone, OpenClaw not adopted.
- **M0 security posture unchanged**: `--approve-all` on the bare host is the risk ADR-001 accepted. Tightening (container or `--deny-all`/`--policy`) is a per-role `SpawnOptions` change plus the deferred containerization pass.
- **One subprocess per prompt**: simple and robust, but not the cheapest possible loop. Acceptable at concurrency 1 (PROJECT.md §6). If concurrency rises, the queue-owner model means follow-up prompts on the same session reuse a warm owner via `--no-wait` + IPC, so we are not paying cold-start per turn.
- **Version pinning is load-bearing**: because we parse raw ACP NDJSON, an ACPX major bump that changes the stream format could break the adapter silently. The pinned range + startup version check makes drift loud. The unknown-`sessionUpdate`-passthrough rule prevents silent data loss on minor additions.
- **Session records accumulate** under `~/.acpx/sessions/` until pruned. Slice 4 calls `close` on teardown; housekeeping (`prune`) is deferred to a daemon slice.
- **Run-log schema is deferred**: Slice 4 returns events to the caller and optionally tees them to a log file. Persisting events to SQLite (the run log) is Slice 5's job and may warrant its own ADR (open question #3 in `M0-VERTICAL-SLICES.md`).
- **Testability**: the adapter shells out to `acpx`, so unit tests use a fake `acpx` shim on PATH (a small script that emits canned NDJSON and exits with chosen codes) rather than mocking child_process internals. Integration with real opencode/pi is a manual smoke test for Slice 9.

## Open questions (deferred)

- **Run-log schema** (SQLite persistence, event indexing, query patterns) — Slice 5 / future ADR.
- **Validator permission posture** — tightened in Slice 6 (likely `--deny-all` + `--no-terminal` or a `--policy` allowlist for test execution).
- **Containerized builder isolation** — ADR-001 defers; revisit before auto-merge or multi-tenant use.
- **Pruning ACPX session records** — daemon housekeeping in a later slice.

## Related

- `docs/PROJECT.md` §4 (anti-corruption layer) — interface updated here; `streamEvents` removed.
- `docs/PROJECT.md` §11 (open question: OpenClaw gateway vs ACPX standalone) — resolved here: ACPX standalone.
- `docs/adr/ADR-001-node-backend-and-embedded-react.md` decision #3 (ACPX first pass) — made concrete here; decision #4 (bare-host isolation) is the security context for `--approve-all`.
- `docs/M0-VERTICAL-SLICES.md` Slice 4 implements this ADR.
- ACPX sources: `openclaw/acpx` README, `docs/CLI.md`, `skills/acpx/SKILL.md` (referenced 2026-07-07, acpx 0.12.0).
