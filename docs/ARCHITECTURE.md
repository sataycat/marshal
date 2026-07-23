# Architecture

The canonical target architecture for Marshal. `PROJECT.md` owns the vision and design tenets; this document owns the product boundaries, state, protocols, and module responsibilities.

Marshal is pre-1.0. Existing code that conflicts with this architecture is migration material, not a compatibility constraint.

---

## 1. Product shape

Marshal is a local-first, browser-based ACP client for software work.

The daemon owns durable state, agent processes, ACP connections, repository access, and background workflows. The web application is the primary and complete product interface. The CLI is only a daemon launcher and lifecycle utility; it is not an agent manager, onboarding wizard, or parallel product surface.

Marshal has two layers:

1. **ACP workbench** — discover, install, authenticate, configure, and converse with ACP agents in a repository context.
2. **Software factory** — compose those agents into durable build, validate, review, and merge workflows.

The workbench is the foundation. Builder, validator, and spec-author are workflow assignments of installed agents, not distinct integration types.

```text
ACP Registry + custom agents
            |
            v
  agent catalog and installer
            |
            v
 authentication + capabilities
            |
            v
 ACP process/session supervisor
       |               |
       v               v
 interactive threads   workflow runs
                       build -> validate -> review
```

---

## 2. System boundaries

### Daemon

The daemon is the sole privileged backend. It owns:

- ACP Registry fetching, validation, and caching.
- Agent installation, versioning, and removal.
- Agent authentication and readiness checks.
- ACP process and session lifecycle.
- Permission mediation and policy enforcement.
- Repository discovery, files, git operations, and worktrees.
- Threads, messages, artifacts, tasks, runs, and events.
- Background orchestration and crash recovery.
- The HTTP and WebSocket API.
- Serving the web application.

### Web application

The web application owns all user-facing product flows:

- First-run setup.
- Registry browsing and search.
- Agent installation, update, removal, and login.
- Custom/private ACP agent registration.
- Agent readiness and capability display.
- Thread creation and agent selection.
- Permission prompts.
- Workflow role assignment.
- Task authoring, progress, review, and merge.
- Daemon and repository diagnostics.

It never spawns agents or accesses the filesystem directly.

### CLI

The CLI is intentionally narrow:

```text
marshal start
marshal stop
marshal status
```

Development-only or recovery commands may exist, but normal product setup and agent management must not depend on them.

---

## 3. ACP Registry

The public ACP Registry is Marshal's default catalog:

```text
https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
```

The registry is a discovery and distribution source, not runtime truth. Marshal validates and caches a registry snapshot, then materializes selected entries into local installations.

Each registry agent may provide:

- Stable ID, name, description, version, icon, license, and links.
- A version-pinned `npx` distribution.
- A version-pinned `uvx` distribution.
- Platform-specific binary archives, command paths, arguments, environment, and optional SHA-256 checksums.

Registry parsing rules:

- Validate required fields at the daemon boundary.
- Reject unsupported registry major versions.
- Ignore safe unknown fields for forward compatibility.
- Enforce response size, timeout, and redirect limits.
- Cache the last valid snapshot and use it when refresh fails.
- Never execute data directly from an unvalidated response.

The public registry is not exclusive. Users can add custom ACP agents for local binaries, private packages, development builds, or private registries. Custom agents enter the same installed-agent and ACP runtime model as public entries.

---

## 4. Agent lifecycle

An agent moves through explicit states:

```text
available -> installing -> installed -> authenticating -> ready
                |             |              |
                v             v              v
              failed       updateable      auth-required
```

These states are independent:

- **Available** means an entry exists in a catalog.
- **Installed** means Marshal can resolve a pinned local launch specification.
- **Authenticated** means the agent's required ACP authentication has completed.
- **Ready** means Marshal has successfully initialized the agent and created a probe session.

Installing an agent never assigns it to a workflow or starts an unattended task. Assignment and execution require separate user actions.

### Distribution installation

Marshal chooses a supported distribution for the host platform:

1. Verified platform binary.
2. Version-pinned `npx` package.
3. Version-pinned `uvx` package.

Preference may be user-configurable, but version pinning is mandatory.

Binary installation must:

- Download into a temporary location.
- Verify SHA-256 when supplied.
- Reject unsafe archive paths, links, device files, and extraction limits.
- Resolve the declared command inside the installation root.
- Mark the version installed with an atomic rename.
- Retain enough provenance to reproduce and audit the installation.

Package distributions are also installations, not moving aliases. The exact package specifier and registry version are persisted. Updating is explicit.

Daemon-owned state has one configurable root. `MARSHAL_HOME` overrides the
default `~/.marshal` location for development, VPS persistent volumes, backup,
restore, and diagnostics:

```text
<MARSHAL_HOME>/
  marshal.db
  registry/
    public-v1.json
  agents/
    <agent-id>/
      <version>/
        <installation-id>/
          manifest.json
          payload/
  credentials/
  repositories/
    <repository-id>/
      attachments/
      artifacts/
      worktrees/
  logs/
  daemon.pid
  daemon.port
```

Registered source checkouts contain project inputs and source code, not Marshal
databases, attachments, artifacts, worktrees, or other daemon state. Secrets do
not belong in SQLite, installation manifests, or repository config; use an OS
credential store or explicit external secret source where available.

---

## 5. Agent catalog and assignments

Marshal distinguishes an installed agent from its use in the product.

### Installed agent

An installed agent has a stable local identity:

```ts
interface InstalledAgent {
  id: string;
  source: "registry" | "custom";
  version: string;
  distribution: "binary" | "npx" | "uvx" | "command";
  launch: AgentLaunchSpec;
  provenance: AgentProvenance;
}
```

`AgentLaunchSpec` is daemon-owned executable detail. It does not appear in task, thread, or workflow APIs.

### Assignment

Product features refer to installed agent IDs:

- A thread selects one installed agent.
- A workflow profile assigns installed agents to `specAuthor`, `builder`, and `validator`.
- Different repositories may use different workflow profiles.
- The same installed agent may fill multiple assignments.
- A validator may be required to differ from the builder by policy.

Assignments can also carry ACP configuration selected after initialization, such as model and mode. They must not duplicate installation details.

There are no agent-specific adapters and no role-specific executable commands. Supporting a new agent is a function of ACP and registry coverage.

---

## 6. Authentication and readiness

Authentication is a first-class product flow, not a prerequisite documented outside Marshal.

After ACP `initialize`, Marshal records the agent's declared authentication methods and capabilities. If authentication is required, the web application presents supported choices.

Supported flows:

- **Agent auth** — Marshal invokes ACP authentication and the agent owns its browser/OAuth flow.
- **Terminal auth** — Marshal opens a browser-accessible terminal backed by a daemon PTY and launches the installed agent with its declared auth arguments and environment.
- **Environment-variable auth** — Marshal collects or references required values and restarts the process with them. Secret storage must use an OS credential store or an explicit external secret source, not plaintext project state.

The readiness probe performs:

1. Process spawn with a bounded timeout.
2. ACP `initialize` and protocol negotiation.
3. Authentication status resolution.
4. ACP `session/new` in a temporary workspace.
5. Session close and process cleanup.

Readiness results include protocol version, supported prompt content, session capabilities, authentication state, and actionable failures. A registry listing alone never implies readiness.

---

## 7. ACP runtime

ACP is the only agent runtime contract.

The runtime supervisor owns:

- Direct process spawning without a shell.
- ACP connection setup over stdin/stdout.
- Protocol negotiation.
- Authentication requests.
- Session create, load, fork, cancel, and close when supported.
- Prompt streaming.
- Capability and configuration negotiation.
- Permission requests.
- Process stderr and lifecycle diagnostics.
- Bounded startup, prompt, idle, and shutdown timeouts.

The product consumes normalized ACP events but preserves the original ACP payload for audit and forward compatibility. Unknown updates are retained rather than discarded.

Marshal must not build provider- or agent-specific behavior into the runtime. Compatibility exceptions belong only in narrowly scoped, documented shims when an agent is demonstrably non-conformant and strategically necessary.

### Process and session scope

An ACP process is an implementation resource; an ACP session is the product-level execution context.

- Interactive threads own or reference an ACP session.
- Workflow runs own an ACP session scoped to their worktree and attempt.
- Session persistence is used when the agent supports it, but Marshal's durable thread and run records remain authoritative.
- Process reuse is an optimization, not an API guarantee.
- Daemon restart recovery depends on recorded session capabilities and IDs; unsupported sessions fail conservatively and remain inspectable.

---

## 8. Threads and messages

A thread is Marshal's durable wrapper around an ACP conversation in one repository context.

Thread state includes:

- Repository and working directory.
- Installed agent ID and resolved agent version.
- ACP session ID when available.
- Selected model, mode, and agent configuration.
- Status, title, pin/archive state, and timestamps.
- Durable user messages, normalized agent events, attachments, and permissions.

The daemon streams live ACP updates over WebSocket and persists them before broadcasting durable events. Reconnection hydrates from HTTP state and resumes the live stream where possible.

Threads must expose ACP capabilities honestly. Image attachment, session resume, model selection, modes, and commands appear only when negotiated with the selected agent.

---

## 9. Permissions

ACP permission requests are mediated centrally by the daemon.

Interactive threads default to user-mediated permissions in the web application. Workflow runs use an explicit policy attached to the workflow profile, such as:

- Reject all.
- Allow reads, ask for writes.
- Allow within the task workspace.
- Unattended allow-all inside an external sandbox.

Permission option selection is based on ACP option kinds, never array position or label text.

ACP permissions are advisory interaction controls, not a sandbox. The process already runs with host-level access. Strong isolation requires a container, VM, or OS sandbox supplied by the execution environment.

---

## 10. Repositories and workspaces

A repository is a durable Marshal resource rather than an implicit consequence of the daemon's current working directory.

The web application can add and open repositories. The daemon validates repository paths and stores repository-scoped preferences, threads, workflow profiles, tasks, and worktrees.

Repository scope is represented by immutable repository IDs and foreign keys in
daemon storage. Repository history is not portable with the checkout, and the
daemon never stores application state in a repository-local `.marshal`
directory. Moving or deleting a checkout therefore does not implicitly move or
delete its Marshal history.

Interactive threads normally use the source checkout unless the user chooses an isolated workspace. Factory tasks always use a dedicated worktree.

Task worktrees are:

- Created from the configured trunk branch.
- Reused across build and validation attempts for that task unless policy requires stronger isolation.
- Never created or mutated by the browser directly.
- Preserved on failure for inspection.
- Removed only after successful merge or explicit cleanup.

---

## 11. Software factory

The software factory is orchestration over installed ACP agents and repository workspaces.

Default task states:

```text
backlog -> ready -> building -> validating -> review -> done
```

The state machine remains durable and daemon-owned, but it is not part of the agent integration layer.

### Workflow profile

A repository workflow profile defines:

- `specAuthor`, `builder`, and `validator` agent assignments.
- Optional model, mode, and agent configuration per assignment.
- Permission and sandbox policy.
- Retry, timeout, and spend limits.
- Worktree setup and deterministic verification commands.
- Whether builder and validator must be decorrelated.

### Build

1. Create or reuse the task worktree.
2. Resolve the pinned builder installation and assignment configuration.
3. Create a workflow ACP session in the worktree.
4. Send the frozen spec and previous validation context.
5. Persist events and artifacts.
6. Run deterministic checks and create a build commit.
7. Transition to validation or stop with an inspectable failure.

### Validate

1. Resolve the pinned validator installation independently.
2. Create a fresh validator ACP session against the build result.
3. Provide the spec, diff, and deterministic verification contract.
4. Run the boundary checks under daemon supervision.
5. Record structured test results and advisory agent findings separately.
6. Pass to review, retry the builder, or escalate according to policy.

The deterministic command result is the gate. Agent narrative is evidence and advice, not the authoritative pass/fail signal.

### Review

The web application presents the frozen spec, diff, checks, agent transcripts, artifacts, and retry history. The human can merge, send back, or abandon. Merge and cleanup remain daemon-owned git operations.

---

## 12. Data model

One SQLite database at `$MARSHAL_HOME/marshal.db` is the durable local store.
Machine-scoped and repository-scoped records share one schema and one ordered
migration stream. Repository-scoped records carry an immutable `repository_id`;
physical consolidation does not weaken repository ownership in APIs or store
modules. The conceptual model is:

- `repositories` — registered source repositories and settings.
- `registry_sources` and `registry_snapshots` — catalog provenance and cached metadata.
- `installed_agents` — pinned installations and launch provenance.
- `agent_auth` — non-secret auth state and credential references.
- `agent_probes` — readiness and capability snapshots.
- `workflow_profiles` and `agent_assignments` — repository-scoped orchestration configuration.
- `threads` and `messages` — durable interactive conversations.
- `sessions` — ACP session metadata and recovery information.
- `permission_requests` — pending and resolved user decisions.
- `tasks` — factory lifecycle and frozen spec state.
- `runs` and `run_events` — build/validate attempts and streamed evidence.
- `artifacts` and `attachments` — bounded metadata for files stored outside SQLite.

Historical records store the resolved agent ID and version used at execution time. Updating an installation never rewrites history.

Files that do not belong in SQLite live under daemon-owned namespaces within
`MARSHAL_HOME`, normally `repositories/<repository-id>/`. The storage root is
the complete persistence boundary for backup, restore, persistent-volume
mounting, and fresh-install reset. Consistent live backup must use SQLite's
supported backup mechanism; otherwise stop the daemon before copying or
removing the storage root.

---

## 13. HTTP and WebSocket API

The API is organized by product resources rather than CLI operations:

```text
/api/repositories
/api/registry
/api/agents
/api/agents/:id/install
/api/agents/:id/authenticate
/api/agents/:id/probe
/api/workflow-profiles
/api/threads
/api/threads/:id/messages
/api/permissions
/api/tasks
/api/runs
/api/artifacts
/api/system
/ws
```

Long-running operations such as installation, authentication, prompts, and workflow runs expose durable operation state and stream progress over WebSocket. A browser refresh must not lose ownership of an operation.

Mutation APIs are idempotent where practical. Errors use a stable machine code plus a human-readable message.

---

## 14. Security

Marshal is an RCE control plane because it installs and runs third-party agent software.

Required controls:

- Bind to localhost by default.
- Require authentication and trusted origins when exposed beyond localhost.
- Treat registry and package metadata as untrusted input.
- Pin versions and preserve provenance.
- Verify checksums and extract archives safely.
- Never interpolate registry fields through a shell.
- Store secrets outside SQLite and JSON config where platform support permits.
- Require explicit user action before installation, authentication, assignment, and unattended execution.
- Make permission and sandbox policy visible at the point of workflow assignment.
- Preserve logs and failed workspaces for audit.

Registry curation establishes interoperability, not trust. ACP permission requests do not confine a malicious process.

---

## 15. Failure and recovery

All long-running operations are durable state machines.

- Registry refresh failure falls back to the last valid snapshot.
- Interrupted installation leaves no active partial version.
- Authentication can be resumed or restarted without reinstalling.
- Agent startup and ACP handshake have hard timeouts.
- Prompt cancellation records both the user action and agent outcome.
- Daemon restart reconciles running operations and processes conservatively.
- Unsupported session resume produces an inspectable stopped state, never a silent retry.
- Workflow retries are policy-driven and recorded as new attempts.

The system prefers explicit failure over pretending an agent is ready, authenticated, resumed, or validated.

---

## 16. Module map

The target backend boundaries are:

```text
src/
  registry/       catalog sources, schema validation, cache
  installations/  distribution selection, download, verify, extract
  agents/         installed catalog, assignments, readiness
  acp/            process supervisor, protocol client, auth, sessions
  permissions/    interactive decisions and workflow policies
  repositories/   repository registry, files, git, worktrees
  threads/        conversations, messages, attachments
  workflows/      profiles, task state machine, build/validate/review
  storage/        SQLite schema and repositories
  daemon/         HTTP, WebSocket, operation supervision
  cli/            daemon lifecycle only
```

The frontend mirrors product domains rather than backend implementation details:

```text
web/src/
  agents/
  repositories/
  chat/
  workflows/
  tasks/
  settings/
  api/
  shell/
```

Legacy direct-command role configuration, CLI-driven onboarding, and agent-specific defaults should be removed as these boundaries land.
