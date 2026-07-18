# Marshal

A local-first, browser-based client for ACP coding agents, with a built-in software factory for turning conversations and specifications into verified changes.

`docs/ARCHITECTURE.md` defines the concrete target architecture. This document defines why Marshal exists and how product decisions should be made.

---

## 1. Vision

ACP makes coding agents interchangeable at the protocol boundary, and the ACP Registry makes them discoverable and distributable. Marshal should be the place where a user can browse those agents, install one, authenticate, open a repository, and start working without manually assembling commands or editing configuration files.

The product starts as a great ACP workbench and grows into a software factory:

```text
discover -> install -> authenticate -> converse -> delegate -> verify -> review
```

Interactive work and autonomous workflows use the same installed agents, sessions, permissions, repository context, and event model. The factory is not a separate integration stack bolted onto chat.

The deployment target is a developer machine, single server, or private VPS. The daemon and durable state run on infrastructure the user controls. Models and agent services may be remote.

---

## 2. Product thesis

Most agent clients stop at conversation. Most coding orchestrators hard-code a small set of executors. Marshal combines the open ACP ecosystem with a durable repository workbench and an opinionated verification loop.

The ACP Registry should determine the breadth of agents Marshal can offer. Marshal's engineering effort should concentrate on the capabilities a generic editor-like ACP client must own:

- Safe installation and updates.
- Authentication.
- Session and process supervision.
- Permissions.
- Repository context and workspaces.
- Durable transcripts and artifacts.
- Workflow composition.
- Deterministic verification and review.

Marshal wins by being an excellent client and orchestrator of the protocol, not by maintaining agent-specific adapters.

---

## 3. Design tenets

1. **Registry-first, ACP-native.** Public registry agents work through standard metadata and ACP. Custom agents use the same runtime path.
2. **The web application is the product.** Installation, authentication, configuration, chat, workflows, diagnostics, and recovery live in the browser. The CLI starts the daemon.
3. **Capabilities over assumptions.** The UI and workflows reflect negotiated ACP capabilities instead of pretending all agents support the same features.
4. **Installations are pinned and auditable.** Discovery may track the latest registry, but execution uses a known agent version and provenance.
5. **Sessions are the shared primitive.** Chat threads and workflow runs are durable products built over ACP sessions, not separate agent integrations.
6. **Workflows assign agents; they do not configure executables.** Builder, validator, and spec-author are repository workflow roles selected from installed agents.
7. **Verification remains the factory's differentiator.** Agent output is useful evidence, but deterministic checks own the pass/fail gate.
8. **Decorrelate build and validation.** Prefer different agents, models, or configurations so validation does not inherit the builder's blind spots.
9. **Explicit trust transitions.** Discovering, installing, authenticating, assigning, and running unattended are separate user decisions.
10. **Local-first does not mean unsandboxed by default.** Marshal owns local state and control, while strong agent isolation remains an explicit execution policy.
11. **Durable operations survive the browser.** Refreshing or disconnecting must not orphan installation, authentication, prompts, or workflow runs.
12. **Pre-1.0 simplicity beats compatibility.** Remove structures that conflict with the product model rather than preserving obsolete command and onboarding formats.

---

## 4. Primary experience

On first launch, the user opens the web application and:

1. Adds or selects a repository.
2. Browses the ACP Registry.
3. Installs an agent with visible version, source, license, and distribution.
4. Authenticates through a browser, terminal, or supported credential flow.
5. Sees a successful ACP readiness probe and negotiated capabilities.
6. Starts a thread with that agent in the repository.

Nothing in this flow should require editing JSON or knowing the agent's executable command.

From a useful thread, the user can continue interactively or promote intent into a factory task. A workflow profile selects the spec author, builder, validator, permissions, isolation, and deterministic checks from the same installed-agent inventory.

---

## 5. The ACP workbench

The workbench should feel like an editor-oriented agent client, not a settings page wrapped around a chatbot.

It includes:

- Repository navigation and file context.
- Multiple durable threads.
- Per-thread agent, model, mode, and capability-aware controls.
- Streaming text, thought, tool, plan, permission, and artifact events.
- Attachments and image prompts when supported.
- Session recovery and explicit failure states.
- Installation and authentication status close to agent selection.
- A path from discussion to an executable task specification.

Marshal should expose what ACP agents actually provide rather than flattening them into a lowest-common-denominator text stream.

---

## 6. The software factory

The factory turns a frozen human-owned specification into a reviewable change:

```text
backlog -> ready -> building -> validating -> review -> done
```

The human owns the two judgment-heavy ends:

- The specification and acceptance criteria.
- The final review and merge decision.

The middle can run unattended once the user has explicitly assigned agents and accepted the permission and isolation policy.

Builder and validator are ordinary installed ACP agents running in workflow sessions. The validator independently examines the implementation and executes the verification contract. Retries, timeouts, spend limits, transcripts, commits, and artifacts are durable evidence.

The deterministic test result is authoritative. Model commentary may explain risks, identify missing coverage, or recommend rejection, but it is not silently converted into a gate result.

---

## 7. Trust and security

Installing and running a registry agent is remote code execution by consent. Registry curation says that an agent interoperates and supports authentication; it does not make the executable safe.

Marshal must make trust transitions legible:

- What source and version will be installed?
- Was the binary checksum verified?
- Which authentication method will run?
- Which repository and workspace will the agent access?
- Which permission policy applies?
- Is the process sandboxed?
- Which agent version produced this conversation, diff, or validation?

ACP permission prompts are valuable controls but not process isolation. Unattended workflows should make container, VM, or OS sandbox execution an explicit profile concern.

---

## 8. Product boundaries

Marshal owns ACP client behavior and repository orchestration. It does not own:

- Model provider accounts or pricing.
- Agent implementation quality.
- A proprietary agent marketplace.
- Agent-specific command documentation.
- Provider-specific adapters when ACP is available.
- A general-purpose package manager beyond installing declared ACP distributions.
- A security sandbox disguised as permission prompts.

Private registries and custom agents may be supported, but they must enter through the same catalog, installation, authentication, readiness, and session abstractions.

---

## 9. Delivery sequence

### M0: Registry-backed ACP workbench

- Daemon lifecycle CLI.
- Repository selection.
- Public registry browsing and cache.
- One installation path with pinned versions.
- Agent authentication and readiness.
- Durable ACP chat with permissions and events.

This proves Marshal as an ACP client.

### M1: Complete agent lifecycle

- Binary, `npx`, and `uvx` distributions.
- Updates, removal, provenance, and failure recovery.
- Agent, terminal, and environment authentication flows.
- Capability-aware model, mode, attachment, and session controls.
- Custom agents and optional private registries.

### M2: Repository workbench

- Multi-repository management.
- Files, diffs, artifacts, and isolated interactive workspaces.
- Strong thread/session recovery.
- A polished path from chat to specification.

### M3: Software factory

- Workflow profiles and agent assignments.
- Worktrees and frozen specifications.
- Build, validate, review, and merge state machine.
- Deterministic verification, retries, and escalation.
- Decorrelated builder and validator policy.

### M4: Isolation and autonomy

- Container or VM execution profiles.
- Spend and resource budgets.
- Concurrent task policy.
- Trust-based automation and narrowly scoped auto-merge.

---

## 10. Success criteria

Marshal is succeeding when:

- Adding a conformant registry agent requires no Marshal code change.
- A new user can install, authenticate, and chat with an agent entirely in the web application.
- Every execution records the exact agent version and capabilities used.
- The same agent inventory powers interactive threads and factory workflows.
- Agent failures are understandable and recoverable without terminal archaeology.
- A factory review contains enough deterministic and conversational evidence for a human to merge confidently.

---

## 11. References

- [Agent Client Protocol](https://agentclientprotocol.com) — runtime interoperability contract.
- [ACP Registry](https://agentclientprotocol.com/get-started/registry) — default catalog and distribution metadata.
- OpenChamber — product reference for a daemon-backed, browser-first ACP workbench.
- Zed — reference ACP client and capability surface.
- vibe kanban — worktree and review workflow precedent.
- no-mistakes — independent validation and verification-gate precedent.
