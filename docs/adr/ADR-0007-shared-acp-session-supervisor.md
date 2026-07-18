# ADR-0007: Shared ACP Session Supervisor

**Status:** Accepted  
**Date:** 2026-07-18  
**Parent:** ADR-0005  
**Amends:** The direct ACP SDK runtime decision in archived ADR-0003  
**Supersedes:** Chat-specific session and permission decisions where they create a runtime path separate from workflow runs

---

## Context

Marshal currently has several product concepts that invoke agents:

- Repository chat threads.
- Spec-author conversations.
- Builder runs.
- Validator runs.

Historically these were added around an `Agent` adapter designed for the factory. Chat wrapped the same basic adapter but acquired its own session, permission, attachment, and persistence decisions. The result risks treating each product feature as a separate agent integration even though ACP already defines the common runtime concepts: process initialization, authentication, sessions, prompts, updates, cancellation, permissions, and capabilities.

The registry-first architecture makes this duplication more costly. Installed agents must behave consistently whether selected for an interactive conversation or assigned to a workflow. Session recovery, model and mode selection, permission decisions, process diagnostics, and capability presentation should not be reimplemented for each feature.

At the same time, ACP processes and sessions are not themselves sufficient product records. Marshal must preserve durable thread and run history even when an agent does not support session loading, a process crashes, or the daemon restarts.

---

## Decision

Marshal will implement one ACP process and session supervisor used by all interactive threads and workflow runs.

ACP is the only agent runtime contract. There are no provider-specific or role-specific runtime adapters when standard ACP can express the behavior.

### Runtime responsibilities

The supervisor owns:

- Resolving an installed agent to a structured local launch specification.
- Spawning the process without a shell.
- ACP transport and protocol negotiation.
- Authentication requests and process restarts required by authentication.
- Session create, load, fork, cancel, and close when supported.
- Prompt submission and streamed updates.
- Model, mode, and other negotiated configuration.
- Permission request routing and outcomes.
- Startup, prompt, idle, cancellation, and shutdown timeouts.
- Stderr, exit, protocol, and cleanup diagnostics.
- Capability snapshots and session recovery metadata.

The supervisor preserves original ACP payloads for audit and forward compatibility while also producing normalized product events for common rendering, persistence, and workflow logic. Unknown ACP updates are retained rather than discarded.

### Product ownership

An ACP process is an implementation resource. An ACP session is the shared execution context. Threads and workflow runs remain Marshal-owned durable records.

- A thread owns or references an ACP session and persists user messages, agent events, permissions, attachments, selected configuration, agent ID, and agent version.
- A workflow attempt owns an ACP session scoped to its repository workspace and persists prompts, events, artifacts, checks, commits, agent ID, and agent version.
- Process reuse is an internal optimization and is not exposed as a product guarantee.
- Session persistence is used only when negotiated and verified for the selected agent.
- Marshal's records remain authoritative even when the ACP session cannot be resumed.

Daemon restart reconciliation is conservative. A resumable session may be loaded when the recorded agent version and capabilities still match. Otherwise the operation stops in an inspectable state; Marshal does not silently replay prompts or invent successful recovery.

### Capability-driven product behavior

The web application and workflow engine derive available behavior from the selected agent's negotiated capabilities.

Examples include:

- Image prompts and other content types.
- Session loading, forking, and closing.
- Models and modes.
- Agent commands and configuration.
- Terminal authentication.

Features are hidden, disabled with explanation, or rejected before execution when unsupported. Marshal does not claim feature parity across installed agents.

### Permission mediation

All ACP permission requests enter one daemon permission broker.

- Interactive threads route decisions to the web application and persist the request and outcome.
- Workflow runs resolve decisions through an explicit workflow permission policy.
- Option selection uses ACP permission-option kinds, never array position or display text.
- A policy that cannot safely resolve a request fails closed.

Permission policy is separate from process isolation. An allow decision does not establish a filesystem sandbox.

### Workflow composition

Builder, validator, and spec-author are assignments in a repository workflow profile. They use the same supervisor as ordinary threads, with different workspace, permission, timeout, retry, and prompt policies.

The factory orchestrator owns task transitions and deterministic checks. It does not own process spawning or agent-specific protocol behavior.

Validation uses a fresh workflow session and independently resolved validator assignment. The deterministic verification command result is the authoritative gate; normalized agent events and narrative findings are retained as evidence.

---

## Consequences

### Positive

- Every installed agent has one compatibility path across chat and workflows.
- Authentication, capability negotiation, permissions, cancellation, and recovery are implemented once.
- The workbench can prove an agent integration before that agent is trusted with unattended work.
- Thread and run histories remain durable independently of agent session support.
- New ACP capabilities can be exposed consistently throughout the product.
- The orchestrator stays focused on workflow state and deterministic verification.

### Negative / Risks

- The supervisor becomes a central, security-sensitive subsystem with substantial lifecycle complexity.
- Capability differences require more conditional product behavior and testing.
- Reliable restart reconciliation is difficult across agents with different session semantics.
- Preserving raw ACP payloads increases storage volume and requires schema/version discipline.
- Process pooling or reuse may be tempting before correctness and isolation are established.

---

## Alternatives considered

1. **Keep the existing `Agent` interface as the permanent product abstraction.** Rejected as the target boundary. It was useful for isolating the original orchestrator, but its spawn/prompt abstraction hides authentication, capabilities, configuration, and session lifecycle now required by the product. A smaller compatibility facade may remain temporarily during migration.

2. **Give chat and workflows separate ACP adapters.** Rejected. It duplicates lifecycle and permission behavior and guarantees inconsistent agent compatibility.

3. **Expose ACP SDK types directly throughout the application.** Rejected. Product persistence and APIs need stable Marshal-owned records, and protocol evolution should remain contained within the ACP subsystem.

4. **Treat ACP sessions as the only durable source of conversation history.** Rejected. Not all agents support load or resume, and agent-owned persistence cannot replace Marshal's audit, UI, and workflow records.

5. **Use agent narrative as the validator gate.** Rejected. The shared session runtime transports evidence; deterministic checks remain the authoritative verification boundary.

---

## Implementation direction

Create explicit ACP process, connection, session, authentication, capability, and permission components behind one supervisor. Migrate interactive chat first, then spec-author, builder, and validator execution. Remove role-specific process factories and duplicate permission/session handling once all consumers use the supervisor.
