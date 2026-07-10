# ADR-019: Coding Agent Agnosticism

## Status

Proposed — 2026-07-10. Supersedes ADR-003 Decision 6 (the closed `AgentId` union, the runtime allowlist, and the `AGENT_TOKENS` registry).

## Context

ADR-003 framed marshal as agent-agnostic at the design level — "the core depends on the `Agent` interface and `AgentEvent` union only … ACPX churn is contained to one adapter file" — and chose ACPX as the universal substrate precisely so any ACP-compatible agent could be plugged in. The promise was a closed but trivially extensible list: "Extensible: unknown ids are rejected in M0; the registry is a plain map so adding claude/codex/gemini/kimi later is a one-line change" (ADR-003 Decision 1).

The implementation, however, baked the roster into three places:

- `src/agent/types.ts:1` — `export type AgentId = "opencode" | "pi";` (a closed string literal union, not a runtime check)
- `src/worktree/config.ts:63` — `VALID_AGENT_IDS = ["opencode", "pi"]` runtime allowlist that throws `InvalidAgentIdError` for any other string
- `src/agent/acpx-adapter.ts:14-17` — `AGENT_TOKENS: Record<AgentId, string>` (currently an identity map, but its typed shape forces any new agent through TS to add an entry)

So today, configuring `agents.validator: "claude-code"` in `~/.marshal/config.json` fails three times in a row: the type system, the config validator, and the adapter. The user is forced to ship a marshal release to add a new agent, which contradicts PROJECT.md §4's anti-corruption stance and the README's promise that any ACP-compatible coding agent can be used.

This is a bug, not a design change: ADR-003's stated intent is to be extensible; the code fails to deliver on it. This ADR closes the gap by passing any agent id through to ACPX as-is.

## Decisions

### 1. `AgentId` is a plain `string`, not a literal union

`src/agent/types.ts:1` becomes:

```ts
export type AgentId = string;
```

Branded types (`string & { readonly __agentId: unique symbol }`) were considered for type safety, but the value (preventing two arbitrary strings from being confused at API boundaries) does not justify the ergonomic cost (every config parse, every test, every call site that constructs an agent id needs a cast). `string` matches the underlying ACPX contract: ACPX takes an opaque agent token positionally on its CLI.

`AgentSession`, `Agent.spawn`'s `agentId: AgentId` parameter, and the rest of the `Agent` interface are unchanged — `string` is a drop-in widening of the literal union.

### 2. Drop the config-time allowlist; accept any string

`src/worktree/config.ts` removes `VALID_AGENT_IDS` (line 63) and the `(VALID_AGENT_IDS as readonly string[]).includes(raw)` check inside `resolveAgentId` (line 91). `resolveAgentId` now returns the raw configured string verbatim, falling back to the per-role default (`builder: "opencode"`, `validator: "pi"`, `specAuthor: "opencode"`) only when the config key is absent.

`InvalidAgentIdError` is removed: there is no validation failure to throw. Its only call site is `resolveAgentId`, which no longer raises. If a future slice reintroduces agent-id shape validation (e.g. a regex), the error class can be reinstated at that point.

The defaults remain so that `marshal init` and out-of-the-box usage keeps working. They are *defaults*, not *gatekeepers*.

### 3. The adapter passes the agent id straight through to ACPX

`src/agent/acpx-adapter.ts:14-17` becomes:

```ts
// Removed. ACPX takes the agent id as a positional CLI argument, so the id
// IS the token. There is no registry to consult.
```

All four ACPX invocations in the adapter (`spawn`, `prompt`, `cancel`, `close`) already use `acpx <agent> ...` with the configured id; the registry was redundant. The change is a pure deletion.

`spawn`'s preflight now only checks that `acpx` is on PATH and that the configured version range is satisfied (both unchanged from ADR-003). It does **not** check that the agent itself (`opencode`, `claude-code`, `pi`, …) is installed or authenticated — that is delegated to ACPX's own startup handshake, and any failure surfaces as an `AgentEvent` of `{type:"error"}` with the agent's stderr message (existing behavior, ADR-003 Decision 5 last bullet).

### 4. The user is the source of truth for which agents marshal can drive

`~/.marshal/config.json` → `agents.{builder,validator,specAuthor}` accepts any non-empty string. The string is passed through to ACPX. If the user names an agent that ACPX does not know (no `acpx <that-agent>` command), the failure surfaces at the first `spawn` call: a child-process ENOENT, an ACPX-side "unknown agent" error, or a successful spawn followed by an ACP `authenticate` failure. All three are surfaced as run events and logged; none are blocked at config load.

The README's config example is updated to show one or two non-default agent ids (e.g. `claude-code` as validator) so the new flexibility is visible at a glance.

### 5. Tests stay as-is; add one regression test

Existing tests that reference `"pi"` and `"opencode"` keep working — both are still valid `AgentId` strings under the widened type. No test needs to be edited for compilation.

Add one test in `src/worktree/config.test.ts` (or a new spec) that exercises a custom agent id end-to-end:

- Configure `agents.builder = "claude-code"`, call `resolveAgentId("builder", config)`, assert it returns `"claude-code"` (no error thrown).
- Call `acpxAdapter.spawn(cwd, "claude-code", {})` against a stub `acpx` shim and assert the shim was invoked with the literal token `claude-code` (no lookup, no transformation).

The test pins the pass-through contract so a future "registry" refactor doesn't quietly reintroduce the allowlist.

## Consequences

- Any ACP-compatible coding agent can be plugged in by config alone — no marshal release required.
- The closed `AgentId` union is gone; the type system no longer enumerates supported agents. This is a small loss of static exhaustiveness (e.g. switch statements lose their default-case guard) but `AgentId` is not used in any switch today, so the practical impact is zero.
- Misconfiguration surfaces at `spawn` time, not at config load. This shifts a class of errors from "fail fast at startup" to "fail on first use" — an acceptable trade because the error message in both cases points to the same root cause (the agent binary or its auth is missing) and the run log captures it.
- `InvalidAgentIdError` is deleted. Any external caller catching it must be updated — there are no external callers (it is an internal store helper).
- ADR-003 Decision 6 is superseded by this ADR. ADR-003's other decisions (the `Agent` interface, the NDJSON event mapping, the `cwd`-scoped sessions, the `--approve-all` default) stand.
- The doc comment on the `Agent` interface in `src/agent/types.ts` should be updated from "Extensible: unknown ids are rejected in M0" to "Any string; the id is passed to ACPX as-is."

## Open questions (deferred)

- **Per-agent prompt templates.** Today, builder and validator prompts are composed from a single template (ADR-006 Decision 4, ADR-007 Decision 3). Different agents may need different prompt framings (e.g. claude-code's system prompt is consumed, opencode's may not be). A per-agent prompt registry is a future concern; the type widening here does not block it.
- **Per-agent permission/timeouts.** ADR-003 Decision 4 left the door open for the validator to use `--deny-all`. Once the agent id is user-chosen, the right default permission mode may also be agent-dependent. Defer until a non-default agent is actually configured and the trade-offs are concrete.
- **Agent discovery.** A future slice might auto-detect installed agents (probe `acpx <id> --version` for a curated candidate list) and surface the available set in `marshal init`. This is a UX nicety, not a correctness fix, and is not on the M0/M1 path.
- **Aliasing.** `agents.builder: "oc"` for `opencode` is plausible but currently impossible because no aliasing exists. A small alias table (e.g. `claude-code` → `claude-code-acp`) is a future addition if the community asks for it.

## Related

- `docs/adr/archived/ADR-003-agent-adapter-and-acpx.md` — Decision 1 (the `Agent` interface) and Decision 6 (the allowlist, **superseded by this ADR**).
- `docs/PROJECT.md` §4 (anti-corruption layer) — the design stance this ADR restores.
- `docs/M0-VERTICAL-SLICES.md` Slice 4 (agent adapter) — the slice that implemented ADR-003 and whose test files are the regression targets.
- `src/agent/types.ts` — `AgentId` widening.
- `src/worktree/config.ts` — `VALID_AGENT_IDS` and `InvalidAgentIdError` removal.
- `src/agent/acpx-adapter.ts` — `AGENT_TOKENS` removal.
