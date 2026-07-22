# ADR-0010: Adaptive Agent Setup and Authentication

**Status:** Proposed  
**Date:** 2026-07-22  
**Related:** ARCHITECTURE.md, PROJECT.md, archived ADR-0005, archived ADR-0006, archived ADR-0007, archived ADR-0008  
**Supersedes:** archived ADR-0009 (Guided Agent Activation)

---

## Context

Marshal is a local-first, browser-based ACP client. A user should be able to
browse the ACP Registry, install an agent, and start working without learning
the agent's executable command or manually editing Marshal configuration.

Marshal already has a stronger installation boundary than clients that treat
installation as a registry settings entry. It resolves and materializes an
exact agent version, records provenance and integrity, and persists a local
launch specification before the agent is available to threads or workflows.
That pinned and auditable installation model is required for durable history,
updates, and unattended workflows and will remain unchanged.

Authentication and provider setup are less uniform than installation:

- Some agents reuse login state, configuration files, environment variables,
  or credential stores that already exist on the Marshal host.
- Some agents advertise ACP authentication methods even while they are already
  authenticated. Advertised methods are available transitions, not current
  authentication state.
- Some agents reject `session/new` with ACP `AuthRequired`, providing a clear
  protocol-level signal that sign-in is required.
- Some agents create a session successfully but discover account, plan, credit,
  or login problems only after the first real prompt.
- Some agents own a browser or device-code flow through ACP `authenticate`.
- Some agents require an interactive terminal setup flow.
- Environment-variable and terminal authentication are still evolving ACP
  features and are not implemented consistently by every agent.
- The ACP launch command is usually a JSON-RPC server command and is not
  necessarily safe or useful to run as an interactive setup command.

Zed succeeds in the common case by allowing agents to reuse machine-level
configuration and delegating agent-specific setup to the agent. Marshal should
preserve that delegation rather than building provider-specific adapters, but
should make blocking setup states and recovery clearer in the web application.

The current proposed ADR-0009 incorrectly states that the UI should request
authentication whenever ACP advertises authentication methods. This would
classify already-authenticated agents such as Codex as unauthenticated and can
prevent them from ever becoming ready.

---

## Decision

Marshal will keep pinned installation, ACP readiness, authentication, workflow
assignment, and unattended authorization as separate daemon-owned states and
trust transitions, while presenting installation and setup as one adaptive,
browser-first product journey.

The normal flow is:

```text
install pinned agent
        |
        v
launch and initialize ACP
        |
        v
attempt session/new
        |
        +-- success ------------------------------> ready to use
        |
        +-- ACP AuthRequired --> sign in/setup --> restart and reprobe
        |
        +-- launch/protocol failure -------------> setup failed with recovery

ready agent receives a prompt
        |
        +-- success ------------------------------> continue conversation
        |
        +-- ACP AuthRequired --> sign in/setup --> recreate session; user retries
        |
        +-- ordinary provider/setup error --------> show agent guidance and actions
```

Marshal will make the common path quiet and the exceptional path obvious. ACP
probe phases, raw capabilities, launch details, and provenance remain available
through progressive disclosure rather than dominating the default interface.

### 1. Installation remains pinned and auditable

An agent is installed only after Marshal can resolve a pinned local launch
specification and persist its provenance. Installation does not mean the agent
is authenticated, ready, assigned, or authorized for unattended work.

The installation trust confirmation will show the information needed to
consent to running third-party code:

- Agent and exact version.
- Source and distribution.
- License.
- Package or archive identity.
- Checksum and integrity status when applicable.

After publication, Marshal automatically launches the installed agent once to
check ACP compatibility and readiness. The primary action remains **Install**;
the UI does not require the user to understand or manually start a readiness
probe.

### 2. Readiness is determined by session creation

The readiness check will:

1. Spawn the pinned launch specification without a shell.
2. Send ACP `initialize` and record the protocol version, capabilities,
   complete authentication methods, and raw initialization payload.
3. Attempt ACP `session/new` in a temporary workspace.
4. Close the probe session when supported.
5. Terminate the probe process and clean up the temporary workspace.

Advertised authentication methods do not determine authentication state.

- If `session/new` succeeds, the installation is **Ready to use**, even when
  authentication methods were advertised.
- If `session/new` returns the typed ACP `AuthRequired` error, the installation
  is **Sign-in required**.
- Other launch, protocol, and session failures become **Setup failed** with a
  stable error code and actionable diagnostic.

Readiness means a fresh process using Marshal's resolved environment
successfully created an ACP session. It does not guarantee provider credits,
model access, account health, or that a later prompt cannot require setup.

### 3. Existing host configuration is reused by default

Agent processes run on the Marshal daemon host and inherit the normal permitted
host environment and user-level configuration context, combined with the
installed launch specification and Marshal-managed credential bindings.

This allows agents to reuse their own existing:

- Login and account state.
- Configuration files.
- Credential caches and stores.
- Environment variables.
- Provider profiles.

Marshal will not copy, import, or claim ownership of agent-managed credentials
merely because an agent discovers them. The UI will explain that the agent runs
on the Marshal host and may reuse configuration already present there.

For a daemon running on a remote machine or private VPS, the browser UI will
make the host boundary explicit: local browser or workstation credentials are
not automatically available on the remote Marshal host.

All readiness, authentication, interactive-session, terminal-authentication,
and workflow launches will use one shared daemon-owned environment resolver so
that setup completed in one path is visible to subsequent agent processes.

### 4. Authentication is requested only when needed

Authentication remains an explicit user action because it may open a browser,
access an account, collect credentials, or run an interactive program.

When ACP returns `AuthRequired`, Marshal will present every advertised method
with its support state and a plain-language explanation. Unsupported methods
remain visible with a reason rather than being silently hidden.

Marshal supports authentication through generic ACP mechanisms:

#### Agent-managed authentication

For an agent-managed method, Marshal sends ACP `authenticate` with the selected
method ID. The agent owns the provider-specific browser, OAuth, device-code, or
account-selection flow. Marshal does not interpret or reimplement that flow.

After the authentication request completes, Marshal starts a fresh process and
repeats the readiness check. Completion of `authenticate` alone is not treated
as proof of readiness.

#### Environment-variable authentication

For a standard ACP `env_var` method, Marshal renders fields from the declared
variables, including labels, secret flags, optional flags, and credential
links. Secret values are stored through a credential-store abstraction and are
referenced, not stored in installation manifests, repository configuration,
operation diagnostics, or ordinary SQLite fields.

The resolved values are injected into every subsequent launch of that
installation, followed by a fresh readiness check.

#### Terminal authentication

For a standard ACP `terminal` method, the daemon owns a PTY and launches the
installed command with only the authentication method's declared additional
arguments and environment. The terminal is streamed to the browser as a
durable authentication operation and runs in the same host and environment
context as future agent processes.

The browser presents this as an agent setup terminal, not a general shell. It
states which host is executing the command and supports cancellation and
reconnection. Terminal exit is followed by a fresh readiness check.

Marshal will not assume that the ordinary ACP server command can be used as an
interactive setup command. A setup terminal is offered only when:

- The agent advertises an ACP terminal authentication method.
- A future validated registry schema declares an explicit setup command.
- A custom agent definition contains an explicit user-approved setup command.

Marshal will not maintain agent-specific setup commands or authentication
adapters.

### 5. Prompt-time setup failures remain recoverable

An agent may create a session successfully and later report a login, account,
credit, subscription, or provider configuration problem.

If `session/prompt` returns typed ACP `AuthRequired`, Marshal will:

- Preserve the user's durable message and prompt text.
- Mark the prompt, session, and thread as authentication-required rather than
  as a generic failure.
- Present the installed agent's current authentication methods.
- End the stale process and authenticate through a supported method.
- Create or reload an ACP session after successful setup.
- Let the user explicitly resubmit the preserved prompt.

Marshal will not automatically replay a failed prompt because the agent may
have partially executed it before returning the error.

If the agent instead returns an ordinary error or message such as insufficient
credits or an instruction to run `/login`, Marshal will present that guidance
prominently but will not reinterpret it as ACP authentication or parse it into
agent-specific behavior. The UI may offer generic actions such as:

- Retry.
- Open an advertised authentication or setup method.
- Send a user-selected command such as `/login`.
- View diagnostics.

Commands inferred from provider names, agent IDs, or arbitrary output are not
executed automatically. Future standardized ACP command or setup metadata may
provide richer generic actions without adding Marshal-specific adapters.

### 6. ACP errors retain protocol identity

ACP errors will remain structured across the protocol client, process/session
supervisor, durable operations, HTTP API, WebSocket events, and browser state.
Marshal will preserve at least:

- JSON-RPC/ACP error code.
- Human-readable message.
- Error data.
- A normalized Marshal failure kind where needed by product state.

The typed ACP error code for `AuthRequired` is authoritative. Marshal will not
detect authentication by matching error-message strings or by checking whether
authentication methods were advertised.

Stable product failure kinds include authentication-required, cancelled,
resource-not-found, protocol-incompatible, process-start-failed, timeout, and
agent-internal-error.

### 7. Complete authentication metadata is preserved

Marshal will persist normalized and raw authentication method data discovered
during initialization, including where present:

- Method ID, type, name, and description.
- Environment variable declarations and credential links.
- Terminal arguments and environment.
- Secret and optional flags.
- ACP `_meta` fields.
- The original method payload.

ACP authentication features are evolving, and `_meta` is an extensibility
boundary. Marshal must not normalize away information needed for future generic
flows. Preserving metadata does not permit undocumented agent-specific
interpretation in the runtime.

### 8. The default UI uses progressive disclosure

The primary installed-agent card shows one user-facing state and one primary
action:

| Internal result | Primary state | Primary action |
|---|---|---|
| Installing or probing | Getting agent ready | None/cancel when supported |
| Probe session succeeds | Ready to use | Start chat |
| ACP `AuthRequired` | Sign-in required | Sign in |
| Launch/protocol/session failure | Setup needed | Resolve setup or retry |
| Authentication in progress | Signing in | Continue/cancel |

Detailed information is available through an expandable details or diagnostics
surface:

- Installation distribution and provenance.
- Integrity and checksum state.
- ACP protocol version and negotiated capabilities.
- Advertised authentication methods.
- Last readiness check.
- Process stderr and structured failure details.
- Raw initialization payload where appropriate for diagnostics.

Normal onboarding does not expose buttons named **Probe readiness** or require
the user to understand ACP initialization. A manual **Retry setup check** may be
available as a secondary recovery action.

### 9. Durable operations and trust boundaries remain explicit

Installation, authentication, terminal setup, readiness checks, assignment,
and unattended execution remain separate durable operations or decisions even
when the browser presents them as one coherent journey.

- Browser navigation or refresh does not orphan an operation.
- Authentication can be resumed, cancelled, or restarted without reinstalling.
- Setup does not assign the agent to a repository or workflow.
- Assignment does not authorize unattended execution.
- Authentication state is associated with the exact installed identity and its
  resolved credential bindings, while historical threads and runs retain the
  agent ID and version they used.

---

## Consequences

### Positive

- Agents already configured on the Marshal host become ready without an
  unnecessary sign-in step.
- Users do not need to understand readiness probes or ACP lifecycle phases.
- Blocking authentication is shown only when ACP provides protocol-level
  evidence that a session cannot start or continue.
- Provider-specific setup remains owned by the agent, avoiding a growing set of
  Marshal adapters.
- Browser, environment-variable, and terminal setup can share one installed
  identity and one reprobe path.
- Prompt-time credential expiry becomes recoverable without losing the user's
  message.
- The default UI stays simple while retaining detailed provenance and
  diagnostics for audit and recovery.
- Local and remote deployments use the same model with an explicit host
  boundary.

### Negative / Risks

- A successful readiness probe cannot guarantee provider credits or account
  health; some failures will still appear during the first prompt.
- Agent-managed browser authentication may behave differently on a remote or
  headless host and requires clear links or instructions from the agent.
- Terminal authentication adds PTY lifecycle, WebSocket streaming, reconnect,
  cancellation, and security complexity.
- Secure environment-variable authentication depends on a viable credential
  store for the host platform.
- Preserving raw ACP metadata and errors increases persistence and API-model
  complexity.
- Users may see agent-provided setup instructions that Marshal cannot turn into
  a first-class action until ACP or registry metadata standardizes them.

### Security

- Installation remains remote code execution by explicit consent.
- Authentication and setup processes run with the access of the Marshal daemon
  user; ACP permissions are not a sandbox.
- Secrets are not stored in installation manifests, repository state, raw
  operation logs, or plaintext diagnostic payloads.
- Terminal setup never accepts arbitrary browser-supplied executables or shell
  interpolation.
- Marshal displays whether setup runs on the local machine or a remote daemon
  host.
- Authentication, repository assignment, and unattended authorization remain
  separate trust transitions.

---

## Alternatives considered

1. **Require authentication immediately after every installation.** Rejected.
   Many agents already have usable host-level configuration, and advertised
   authentication methods do not indicate current auth state.

2. **Treat any advertised authentication method as sign-in required.**
   Rejected. ACP methods describe available transitions. Agents such as Codex
   may always advertise them, including while authenticated.

3. **Defer every setup problem to the user's external terminal.** Rejected as
   the target experience. It keeps Marshal simple internally but violates the
   browser-first product goal and leaves remote deployments especially poor.
   External setup remains a fallback when the agent exposes no usable generic
   mechanism.

4. **Run every installed ACP command in a browser terminal for setup.**
   Rejected. ACP server commands commonly reserve stdin/stdout for JSON-RPC and
   may not implement an interactive setup mode.

5. **Add provider- or agent-specific login adapters and error parsing.**
   Rejected. This duplicates agent behavior, does not scale with the registry,
   and conflicts with ACP as the sole runtime contract.

6. **Consider successful installation equivalent to readiness.** Rejected.
   Materialization does not prove process startup, protocol compatibility, or
   session creation.

7. **Automatically replay prompts after authentication.** Rejected. A prompt
   may have partially executed, making automatic replay unsafe and potentially
   destructive.

---

## Implementation direction

Implementation is incremental, but each phase uses the final generic model.

### Phase 1: Correct readiness and error semantics

- Always attempt `session/new` after `initialize`.
- Return authentication-required only for typed ACP `AuthRequired`.
- Preserve initialization metadata when session creation fails.
- Carry structured ACP errors through the runtime and API.
- Add regression coverage for an agent that advertises auth methods while an
  existing host login allows `session/new` to succeed.
- Simplify the primary agent card and move probe details behind diagnostics.

### Phase 2: Complete browser authentication

- Preserve complete normalized and raw auth method payloads.
- Use a shared process environment resolver for every agent launch.
- Refine agent-managed authentication and automatic reprobe.
- Implement standard `env_var` forms and credential references.
- Show unsupported advertised methods with an explanation.

### Phase 3: Runtime recovery

- Add authentication-required session, prompt, and thread states.
- Preserve failed prompt text and expose an explicit resubmit action.
- Recreate or reload sessions after authentication.
- Apply the same structured stop state to workflow runs without silently
  retrying unattended work.

### Phase 4: Terminal setup

- Add daemon-owned PTY authentication operations.
- Stream terminal input/output through authenticated WebSocket channels.
- Support browser reconnect, cancellation, bounded lifecycle, and audit-safe
  diagnostics.
- Reprobe after terminal completion.

High-value tests include readiness with advertised methods and existing login,
typed `AuthRequired` from `session/new` and `session/prompt`, metadata
preservation, secret redaction, environment consistency across probe and normal
sessions, authentication cancellation, prompt preservation without automatic
replay, PTY command containment, and daemon restart reconciliation.
