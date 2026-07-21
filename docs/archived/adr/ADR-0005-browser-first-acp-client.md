# ADR-0005: Browser-First ACP Client

**Status:** Accepted  
**Date:** 2026-07-18  
**Parent:** —  
**Supersedes:** Product scope and sequencing in archived ADR-0001 and ADR-0002 where they define Marshal primarily as a board/factory client or make agent configuration an external prerequisite

---

## Context

Marshal began as a software-factory orchestrator with a web board over a build, validate, review, and merge state machine. Interactive chat was later added as a way to dogfood ACP agents and improve specification authoring. Agent executables, authentication, and role configuration remained external concerns handled through files and CLI onboarding.

The ACP ecosystem now provides two stable boundaries that change the appropriate product shape:

- The Agent Client Protocol defines how an editor-like client communicates with an agent.
- The ACP Registry defines how compatible agents are discovered and distributed.

If Marshal continues to treat agents as preconfigured executables, users must leave the product to discover an agent, understand its command, install it, authenticate it, edit configuration, and diagnose failures. The browser would expose only the final orchestration layer while omitting the lifecycle that makes an ACP client usable.

Marshal is pre-1.0, so existing CLI and direct-command workflows are not compatibility constraints. The architecture can be redrawn around the protocol rather than adapting the registry to the current role configuration.

---

## Decision

Marshal will be a local-first, browser-based ACP client for software work. The web application is the complete product interface, and the daemon is its privileged local backend.

Marshal has two product layers:

1. **ACP workbench** — repository selection, agent discovery, installation, authentication, readiness, interactive threads, permissions, and artifacts.
2. **Software factory** — specification, build, validation, review, and merge workflows composed from the same installed agents and ACP runtime.

The workbench is foundational. The factory is an orchestration feature built over it, not a separate agent integration stack.

### Web application responsibilities

Normal user flows belong in the web application:

- Add and select repositories.
- Browse registry and custom agents.
- Install, update, remove, and authenticate agents.
- Inspect readiness and negotiated capabilities.
- Create threads and select agents.
- Resolve interactive permission requests.
- Assign installed agents to workflow roles.
- Configure and operate factory workflows.
- Inspect system, agent, repository, thread, and run diagnostics.

The browser does not spawn processes, read arbitrary host paths, or communicate with ACP agents directly. It calls the daemon API and renders durable operation state.

### Daemon responsibilities

The daemon owns all privileged and durable behavior:

- Registry access and local installations.
- Credentials references and authentication processes.
- ACP processes, sessions, permissions, and event streams.
- Repository, filesystem, git, worktree, and workflow operations.
- SQLite state, artifacts, operation recovery, HTTP, and WebSocket APIs.

Long-running operations continue independently of a browser connection. Refreshing or closing the web application must not orphan an installation, authentication attempt, prompt, or workflow run.

### CLI boundary

The supported CLI product surface is limited to daemon lifecycle and process inspection:

```text
marshal start
marshal stop
marshal status
```

Development and emergency recovery commands may exist, but normal discovery, installation, authentication, diagnostics, repository setup, and workflow configuration must not require the CLI.

### Repository model

Repositories are explicit durable resources registered through the web application. Marshal does not define the active product repository solely from the daemon's current working directory.

Repository-scoped state includes threads, workflow profiles, tasks, workspaces, and preferences. Machine-scoped agent installations can be reused across repositories.

---

## Consequences

### Positive

- Marshal becomes usable without command discovery or manual JSON editing.
- Installation and authentication failures can be presented in the same interface where the user selects an agent.
- Interactive threads become a first-class product rather than auxiliary factory plumbing.
- The factory reuses proven workbench infrastructure instead of maintaining a separate agent path.
- The daemon remains the single security and persistence boundary.
- A remote Marshal deployment presents the same product as a local deployment.

### Negative / Risks

- The web application and daemon API grow substantially beyond the current task board and chat surfaces.
- Browser-driven terminal authentication requires a daemon PTY and terminal UI.
- Repository registration introduces path validation and multi-repository state that current cwd-based flows avoid.
- Durable background operations require explicit reconciliation after daemon restarts.
- Existing CLI onboarding and direct config documentation become obsolete before all replacement web flows are implemented.

---

## Alternatives considered

1. **Keep Marshal factory-first and add a small registry picker.** Rejected. A picker does not solve installation, authentication, readiness, updates, permissions, or diagnostics and preserves the wrong product boundary.

2. **Keep agent management in the CLI and use the web application only for chat and tasks.** Rejected. It creates two product surfaces, makes remote use dependent on terminal access, and forces users to leave the primary interface for routine lifecycle operations.

3. **Make the browser communicate directly with ACP agents.** Rejected. Browsers cannot safely own local process, filesystem, credential, or worktree access, and remote deployments still require a privileged host component.

4. **Remove the factory and ship only an ACP chat client.** Rejected. The verification workflow remains Marshal's differentiator. It is retained as a higher-level composition over the workbench.

---

## Implementation direction

The migration begins with the registry-backed workbench and then rebuilds factory integration on top of the resulting agent inventory and session supervisor. Legacy direct-command role configuration and CLI onboarding may be deleted rather than supported in parallel unless a concrete persisted-data migration is required.
