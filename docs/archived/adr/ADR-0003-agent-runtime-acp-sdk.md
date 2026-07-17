# ADR-0003: Agent Runtime — Direct ACP SDK

**Status:** Accepted
**Date:** 2026-07-15  
**Parent:** —  
**Amends:** ADR-0002 (chat interface) and the Chat Session Model child ADR (ACPX-specific session implementation)  
**Supersedes:** The planned implementation described by the archived M0 reference to ADR-003

---

## Context

Marshal is agent-agnostic and targets the [Agent Client Protocol](https://agentclientprotocol.com) (ACP). The daemon owns orchestration, worktrees, validation, persistence, and the HTTP/WebSocket API. The browser is a thin client and must not communicate with coding agents directly.

Marshal originally used `AcpxAgentAdapter`, which shelled out to the `acpx` CLI and mapped ACPX's NDJSON output into Marshal's internal `AgentEvent` union. ACPX provided more than protocol serialization:

- ACP process startup and connection management
- Named and persistent sessions
- Prompt queueing and session ownership
- Cancellation and close operations
- Agent ID to executable command resolution
- Headless permission flags and timeout behavior
- A stable CLI surface for multiple ACP-compatible agents

The official `@agentclientprotocol/sdk` provides typed TypeScript implementations for ACP clients and agents. A direct SDK integration would let Marshal spawn configured ACP agent processes itself and communicate through typed ACP methods and notifications. It would remove the global ACPX runtime dependency and make new ACP capabilities easier to adopt.

However, the SDK is a protocol library, not an agent gateway. It does not automatically provide ACPX's persistence, command registry, process supervision, permission policy, retries, or diagnostics. Moving to the SDK therefore transfers operational ownership to Marshal; it is not a simple dependency replacement.

The existing `Agent` interface already isolates the orchestrator from ACPX:

```typescript
interface Agent {
  spawn(cwd, agentId, opts?): Promise<AgentSession>;
  prompt(session, text, opts?): AsyncIterable<AgentEvent>;
  cancel(session): Promise<void>;
  close(session): Promise<void>;
}
```

This provides a migration seam without changing the task state machine, run log, validator gate, or frontend API.

### Current boundary

```text
Browser -> Marshal HTTP/WebSocket API -> Marshal daemon -> ACP agent
```

The browser-to-daemon boundary is correct and is not under consideration.

---

## Decision

Marshal will make the direct ACP SDK integration the target agent runtime while preserving the `Agent` interface as the orchestrator boundary.

Marshal uses `SdkAcpAgentAdapter` through `@agentclientprotocol/sdk` as its sole agent runtime. ACPX, string agent IDs, ACPX installation checks, ACPX doctor probes, and ACPX configuration keys are removed.

The earlier requirement to test at least three real ACP agents before switching the generated default is waived. The direct adapter's fake-process coverage and existing builder/validator contract coverage are accepted as sufficient to make the architectural cut now; real-agent compatibility remains ongoing operational validation rather than an ADR exit gate.

Marshal will own the following responsibilities in the direct adapter:

- Spawn the configured ACP agent executable with piped standard streams.
- Establish an ACP NDJSON connection using the SDK.
- Perform ACP initialization and session creation or loading.
- Stream typed session updates into Marshal's `AgentEvent` union.
- Implement the configured permission policy.
- Implement timeout, cancellation, error, and process cleanup behavior.
- Track the ACP session ID and process state in `AgentSession`.
- Surface agent startup and protocol failures as durable run events.

The orchestrator will continue to depend only on `Agent`. No frontend route, WebSocket event, task transition, validator gate, or run-log schema will depend on ACPX or the SDK.

### Agent command configuration

Direct ACP execution requires an explicit executable command. Agent IDs alone are insufficient because ACP does not define a universal registry. Marshal will represent commands as structured argv data rather than shell command strings:

```typescript
interface AgentCommand {
  id: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}
```

Example configuration:

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

Marshal must not pass configured commands through a shell. Structured arguments avoid quoting ambiguity and reduce command-injection risk. Installation hints may remain human-readable strings, but execution uses the parsed command and argument array.

### Session model

Marshal continues to own its application-level task runs and chat threads. An ACP session is an implementation detail attached to an `AgentSession`.

The direct adapter will prefer this lifecycle:

```text
spawn process
  -> initialize
  -> session/new, or session/load when supported and explicitly persisted
  -> session/prompt
  -> session/update stream
  -> session/cancel or prompt completion
  -> process/session cleanup
```

The SDK does not guarantee ACPX-equivalent durable sessions. Marshal will not claim restart-resumable sessions until it persists the necessary command, cwd, ACP session ID, capability information, and recovery state, and has verified that the target agent supports loading sessions. A daemon crash remains conservatively recoverable through manual re-queue as specified by the architecture.

For the current builder and validator flow, one ACP process and one prompt turn per run is sufficient. More advanced session reuse is a separate capability and must not be assumed by the adapter.

### Permission policy

Permission handling moves from ACPX flags into an explicit Marshal policy. The direct adapter must implement the ACP client-side `requestPermission` handler and choose an outcome based on policy.

Initial headless defaults remain equivalent to current behavior:

- Builder: `approve-all`
- Validator: `approve-all`
- Non-interactive permission failure: enabled when a request cannot be safely resolved by policy

The policy must be explicit in adapter options and must not rely on selecting the first ACP permission option. Future interactive clients may provide a permission broker through the daemon API, but that is outside this ADR.

### Event mapping

The existing `AgentEvent` union remains the daemon's stable event format. The SDK adapter maps ACP notifications as follows:

- `agent_message_chunk` text -> `text`
- `agent_thought_chunk` -> `thinking`
- Tool calls and updates -> `tool`
- Permission requests and outcomes -> `permission`
- Process and protocol diagnostics -> `log` or `error`
- Completed prompt response -> `done`
- Unknown or newly introduced ACP update variants -> `log` with preserved structured metadata where practical

The mapping is intentionally Marshal-owned. ACP's typed schema is the transport contract; `AgentEvent` is the product's run-log and WebSocket contract.

---

## Migration Plan

### Phase 1: Adapter seam

- Add the SDK dependency to the daemon package.
- Keep `Agent`, `AgentSession`, and `AgentEvent` unchanged unless a concrete ACP capability requires an additive field.
- Refactor shared event and policy mapping out of ACPX-specific code where useful.
- Add a fake ACP agent process for SDK adapter tests.

### Phase 2: Direct adapter

- Implement initialization, session creation, prompt streaming, permission responses, cancellation, timeout, and cleanup.
- Support configured `command`, `args`, and optional environment variables.
- Preserve clear errors for missing executables, non-zero exits, protocol errors, and unsupported capabilities.
- Run the existing builder, validator, retry, run-log, and WebSocket tests using the SDK adapter.

### Phase 3: Compatibility operation (completed historically)

- Select the adapter from configuration or an internal feature flag.
- Keep ACPX available for users and agents not yet compatible with the direct adapter.
- Add a doctor probe for direct ACP initialization and `session/new` without sending a prompt.
- Test at least three real ACP agents with different executable styles, including one Node-based agent and one native executable.

### Phase 4: ACPX retirement (completed)

The original retirement criteria were:

- The SDK adapter is the default.
- The supported agent matrix passes initialization, prompt streaming, permissions, cancellation, timeout, and cleanup tests.
- Builder and validator runs produce equivalent durable events and state transitions.
- Direct startup and diagnostic errors are at least as actionable as the ACPX errors.
- No required Marshal feature depends on ACPX-only session persistence or queue ownership.
- Documentation and configuration no longer require ACPX.

The project chose full retirement rather than retaining an optional compatibility adapter. The compatibility-matrix criterion was explicitly waived to avoid maintaining two runtimes indefinitely. No required Marshal feature depended on ACPX-only session persistence or queue ownership, and direct startup, diagnostics, durable event mapping, and state transitions were already covered by automated tests.

---

## Consequences

### Positive

- Marshal depends directly on the ACP standard instead of an intermediary CLI.
- No global ACPX installation is required for the direct path.
- Typed protocol handling replaces hand-written ACP JSON-RPC parsing.
- New ACP methods and capabilities can be adopted without waiting for ACPX CLI support.
- Process, permission, timeout, and diagnostic behavior become explicit Marshal policies.
- The existing orchestrator and frontend remain stable because the `Agent` boundary is preserved.
- Agent configuration becomes more portable and explicit than an opaque ACPX agent ID.

### Negative / Risks

- Marshal takes ownership of process supervision and lifecycle edge cases.
- Direct configuration is more verbose and requires executable command details.
- ACP-compatible agents may differ in command shape, authentication, capabilities, and session behavior.
- Durable session resumption is harder without ACPX's persistence and queue-owner model.
- Permission policy becomes security-sensitive Marshal code.
- Existing string-role configurations must be migrated to structured commands. `marshal init` replaces legacy string roles with generated direct defaults; `marshal doctor` rejects them with a migration hint.
- The SDK and ACP specification are evolving; Marshal must pin compatible SDK versions and test protocol behavior rather than relying only on TypeScript types.

### Security

The SDK does not sandbox agents. The direct adapter has the same RCE and host-permission risks as ACPX. Marshal continues to bind the daemon to localhost by default, and worktrees remain a filesystem scope convention rather than a security boundary. Container or VM isolation remains an operator responsibility.

Structured command arguments reduce shell parsing risk but do not make agent execution safe. Configured agent commands and environment variables must be treated as executable code.

---

## Alternatives Considered

1. **Keep ACPX as the only implementation.** Rejected. It adds a runtime dependency and makes ACPX's CLI and persistence model the practical compatibility contract instead of ACP itself.

2. **Replace the `Agent` interface with the SDK directly throughout the daemon.** Rejected. It would spread protocol types and lifecycle assumptions through the orchestrator, run logging, and future clients. The adapter boundary is small and already proven.

3. **Build a new Marshal-specific agent registry and provider SDKs.** Rejected. Marshal should consume ACP-compatible executables and configuration, not reimplement provider integrations or maintain a vendor allowlist.

4. **Call ACP from the frontend.** Rejected. It violates the thin-client/fat-daemon boundary, exposes process and credential concerns to the browser, complicates local security, and would prevent the CLI and future clients from sharing orchestration behavior.

5. **Remove session persistence entirely.** Deferred, not selected. Direct ACP runs can initially use one process per run, but Marshal-owned threads and future interactive chat need a clear path to session resumption. The capability must be designed explicitly rather than inherited accidentally from ACPX.

---

## Documentation Impact

The implementation updates the following references:

- `docs/ARCHITECTURE.md` §5: describe the SDK adapter, command configuration, and permission ownership.
- `docs/PROJECT.md` §3 and §8: describe direct ACP as the durable substrate.
- `docs/archived/adr/ADR-0002-chat-interface.md`: preserve the Marshal-owned thread model summary but replace ACPX-specific lifecycle claims with adapter-neutral ACP session behavior (full session-model detail now lives in the Chat Session Model child ADR).
- `AGENTS.md`: remove the ACPX prerequisite and string-role support.
- Human testing and onboarding documentation: document agent command configuration and direct ACP diagnostics.

## Implementation Status

Implemented:

- `SdkAcpAgentAdapter` using `@agentclientprotocol/sdk` for initialization, session creation, prompt streaming, permission handling, cancellation, timeout, and cleanup.
- Structured per-role commands in `~/.marshal/config.json`; string role entries are retired.
- Shared runtime selection for builder, validator, and spec-author roles.
- Direct ACP doctor probes that initialize and create a session without sending a prompt.
- Fake ACP process coverage for events, permissions, cancellation, timeout, cleanup, and missing executables.
- Direct generated defaults for opencode (builder/spec author) and pi (validator).
- Removal of `AcpxAgentAdapter`, ACPX tests, ACPX preflight/version checks, ACPX doctor probes, and the `acpx` config section.
- Legacy string-role migration during `marshal init` and explicit rejection during `marshal doctor` or runtime role resolution.

No ADR exit criteria remain. Real-agent testing is recommended release validation, not a condition for the direct runtime default or ACPX retirement.
