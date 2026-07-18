# ADR-0005 Implementation TODO

This plan implements [ADR-0005: Browser-First ACP Client](docs/adr/ADR-0005-browser-first-acp-client.md). ADR-0005 is accepted but its migration is still pending. [ADR-0006](docs/adr/ADR-0006-registry-backed-agent-lifecycle.md) and [ADR-0007](docs/adr/ADR-0007-shared-acp-session-supervisor.md) define the target agent-lifecycle and runtime seams used by these slices.

The current application already has useful chat, task, worktree, ACP SDK, permission, HTTP, WebSocket, and factory behavior. The implementation should preserve those capabilities while replacing implicit repository state, direct role commands, and consumer-owned ACP sessions with the browser-first architecture.

## Working Rules

- Complete slices in order unless a dependency section explicitly permits parallel work.
- Each slice must deliver browser-observable behavior across persistence, daemon API, and web UI. Do not land a database-only or UI-only slice.
- Keep the daemon as the sole owner of filesystem, process, ACP, credential-reference, git, and durable-operation behavior.
- Use ACP as the only runtime contract. Do not add agent-specific adapters or defaults.
- Persist exact installed agent ID and version on every new thread and workflow run.
- Keep discovery, installation, authentication, readiness, assignment, and unattended execution as separate transitions.
- Do not expose launch commands or registry arguments as thread or workflow configuration.
- Preserve raw ACP payloads at the ACP boundary while exposing Marshal-owned API and persistence types.
- Update `docs/HUMAN-TESTING-GUIDE.md` whenever a product flow changes.
- Add backend tests for persistence, lifecycle, error, and recovery behavior. Test pure frontend logic, but do not add React appearance tests.
- For backend-only slices, run `pnpm run check`, then `pnpm run test`. For slices changing `web/`, run `pnpm run check:all`, then `pnpm run test:all`. Never run verification commands in parallel.
- A coding agent should implement one slice at a time, mark its checkbox only after acceptance and verification pass, and record any deliberate scope change directly under that slice.

## Completion Target

ADR-0005 is implemented when a new user can perform this path without `marshal init`, editing JSON, or knowing an executable command:

```text
start daemon
-> open web application
-> register repository
-> browse ACP Registry
-> install a pinned agent
-> authenticate if required
-> pass readiness probe
-> create a version-pinned thread
-> assign installed agents to a workflow
-> build, validate, review, and merge through the web application
```

## [x] Slice 1: Register And Select A Repository

**Goal:** Marshal starts as a machine-scoped daemon rather than a product implicitly bound to its current working directory.

**User-visible result:** A user opening Marshal with no selected repository sees a setup screen. They can add a local git repository by path, select it, refresh the browser, and return to the same selection. Invalid, missing, and non-git paths produce actionable errors.

**Implementation:**

- Add daemon-owned machine storage independent of `<repo>/.marshal/state.db`.
- Add a durable `repositories` resource with stable ID, canonical path, display name, timestamps, and repository-scoped preferences.
- Add repository list, register, inspect, select, and remove APIs under `/api/repositories`.
- Canonicalize paths, verify the directory exists, verify it is a git worktree, and prevent duplicate registration through equivalent paths.
- Make the selected repository explicit in daemon requests and frontend state. Do not infer product context from `process.cwd()`.
- Add a first-run repository setup screen and repository switcher in the application shell.
- Scope new threads and tasks to a repository ID while retaining their resolved repository path for execution.
- Handle current per-repository persisted data explicitly: implement a bounded import into the machine store or document and test a deliberate pre-1.0 reset. Do not silently abandon an existing database.

**Acceptance:**

- Register two temporary git repositories, switch between them, and observe separate thread/task lists.
- Refreshing the browser and restarting the daemon preserve registered repositories and the selected repository.
- Registering the same repository through a symlink or path variant does not create a duplicate.
- Removing a repository registration does not delete the source checkout.

**Likely areas:** `src/repositories/`, `src/storage/` or the existing `src/db/`, `src/daemon/http.ts`, `web/src/repositories/`, `web/src/shell/`, API query state, repository and daemon API tests.

**Out of scope:** Repository file browsing redesign, isolated interactive workspaces, remote repository cloning.

**Implemented:** Machine-scoped repository registrations live in `~/.marshal/machine.db`; legacy checkout-local databases are preserved in place and continue to be selected explicitly through the browser. The daemon lifecycle port file remains compatible with root-scoped test callers, while normal `marshal start` uses the machine-level default.

## [x] Slice 2: Browse A Cached Registry Catalog

**Depends on:** Slice 1.

**Goal:** The browser presents validated ACP Registry metadata without executing it.

**User-visible result:** An Agents area lists public registry agents with search, version, description, source, license, links, and supported distributions. The user can refresh the catalog. A failed refresh retains the last valid snapshot and clearly shows that it is stale.

**Implementation:**

- Create a `src/registry/` boundary for sources, schema validation, fetching, and snapshots.
- Fetch the public v1 registry with response-size, timeout, and redirect limits.
- Reject unsupported major versions and invalid required fields. Ignore safe unknown fields.
- Persist source and last-valid snapshot provenance in machine storage.
- Never pass unvalidated registry data to installation or ACP runtime code.
- Add catalog list, detail, and refresh APIs under `/api/registry`.
- Add durable refresh status or an operation record so a browser disconnect does not make refresh ownership ambiguous.
- Add the browser catalog, search/filter behavior, refresh status, empty state, and stale-cache warning.

**Acceptance:**

- A valid fixture appears in the browser and can be searched by ID, name, or description.
- An invalid or oversized response is rejected without replacing the last valid snapshot.
- With the network unavailable, the last valid snapshot remains browsable and is marked stale.
- Registry launch arguments are not presented as editable product configuration.

**Likely areas:** `src/registry/`, storage schema, `src/daemon/http.ts`, `web/src/agents/`, API client/query keys, registry parser and HTTP tests.

**Out of scope:** Private registries, custom agents, installation, updates.

## [x] Slice 3: Install One Pinned Agent Distribution

**Depends on:** Slice 2.

**Goal:** A registry entry can become a distinct, auditable installed-agent record through an explicit browser action.

**User-visible result:** A user selects a supported version-pinned `npx` distribution, reviews source/version/license/distribution and an RCE warning, confirms installation, watches durable progress, refreshes the browser, and later sees either an installed agent or an inspectable failure.

**Implementation:**

- Create separate `src/installations/` and `src/agents/` boundaries.
- Add installed-agent identity, exact version, source, registry snapshot provenance, distribution, launch specification, integrity status, lifecycle status, and timestamps.
- Support one minimal distribution path: an exact version-pinned `npx` package. Reject moving aliases such as `latest`.
- Persist a resolved structured launch specification. Spawn package tooling without a shell.
- Add a reusable durable-operation model while implementing installation; do not build a disconnected operation framework with no product consumer.
- Make installation idempotent for the same agent/version/distribution and preserve actionable failure details.
- Ensure interrupted work cannot appear as an active completed installation.
- Add installed-agent list/detail APIs and install/remove mutations under `/api/agents`.
- Add install confirmation, progress, failure, retry, and Installed Agents views.
- Do not assign the installed agent to chat or a workflow automatically.

**Acceptance:**

- Starting an installation and refreshing the browser does not lose its status.
- Successful installation records the exact package specifier and registry snapshot provenance.
- A duplicate request returns or reuses the same installation rather than racing a second install.
- A failed or interrupted installation is not selectable as installed.
- Removal deletes Marshal-owned installation state without rewriting historical thread/run records.

**Likely areas:** `src/installations/`, `src/agents/`, storage schema, daemon operation supervision, `web/src/agents/`, installation and API tests.

**Out of scope:** Binary archives, `uvx`, updates, custom agents, checksumless-binary policy.

**Implemented:** Machine-scoped installed-agent and installation-operation records are persisted in `machine.db`. The first distribution path is an exact semver-pinned `npx` package, launched without a shell in a durable operation. Registry cards support explicit confirmation, progress, retry, removal, and idempotent duplicate requests; failed installations remain inspectable and are never selectable as installed.

## [x] Slice 4: Probe Readiness And Show Capabilities

**Depends on:** Slice 3.

**Goal:** Installed and ready are separate product states.

**User-visible result:** A user probes an installed agent and sees `ready`, `authentication required`, or an actionable failure. The agent detail shows protocol version and negotiated capabilities. Unsupported product controls are hidden or disabled with an explanation.

**Implementation:**

- Introduce the first `src/acp/` boundary around the existing SDK mechanics.
- Resolve only an installed-agent launch specification; the ACP layer must not read registry metadata or install packages.
- Implement bounded process spawn, ACP initialize, authentication-state resolution, temporary `session/new`, session close, and process cleanup.
- Persist probe status, protocol version, normalized capabilities, raw initialization metadata where appropriate, diagnostics, and timestamps.
- Add probe/readiness APIs under `/api/agents/:id/probe` and agent detail responses.
- Expose capability data through Marshal-owned API types rather than ACP SDK types.
- Add readiness and capability presentation to agent detail and agent selectors.

**Acceptance:**

- A conformant no-auth fake agent reaches `ready` after a successful temporary session.
- Startup timeout, protocol failure, session creation failure, and early process exit produce distinct actionable failures.
- Probe cleanup leaves no live process or temporary workspace.
- An authentication-required agent does not appear ready.
- Image/model/mode/session controls are not shown as supported unless negotiated.

**Likely areas:** `src/acp/`, `src/agents/`, `src/agent/sdk-adapter.ts` migration seams, storage schema, agent APIs, agent detail UI, ACP fixture tests.

**Out of scope:** Long-lived chat sessions, terminal authentication, environment-secret collection.

**Implemented:** Installed agents now have durable readiness and capability state. The daemon probes only the persisted launch specification, performs ACP initialize plus a temporary session, classifies ready/authentication-required/failure outcomes, persists normalized capabilities and raw initialization metadata, and exposes `/api/agents/:id/probe`. The Agents UI presents probe status, protocol version, image capability, authentication-required state, and actionable failures.

## [x] Slice 5: Complete Agent-Managed Authentication

**Depends on:** Slice 4.

**Goal:** At least one authentication-required registry agent can become ready entirely through the web application.

**User-visible result:** An installed agent that advertises agent-managed ACP authentication presents its supported method in the browser. The user starts authentication, follows the agent-owned browser/OAuth flow, returns to Marshal, and re-probes to reach ready. Failure and cancellation remain inspectable.

**Implementation:**

- Persist non-secret agent authentication state and authentication operation history separately from installation and probe state.
- Add authenticate, inspect, cancel/restart, and re-probe APIs under `/api/agents/:id`.
- Let ACP own the advertised authentication flow; do not add provider-specific OAuth code.
- Keep secrets and tokens out of SQLite, JSON config, logs, WebSocket events, and installation manifests.
- Make authentication a durable operation that survives browser refresh and fails explicitly after daemon restart if it cannot resume safely.
- Add authentication method, progress, cancellation, error, and retry UI.

**Acceptance:**

- A fake authentication-required ACP agent transitions from installed to auth-required to ready.
- Authentication failure does not require reinstalling the agent.
- Browser refresh preserves the operation and latest state.
- Logs and persisted records contain no fixture secret values.
- Installing or probing never silently starts authentication.

**Likely areas:** `src/acp/`, `src/agents/`, auth-state storage, durable operations, agent APIs and UI, authentication lifecycle tests.

**Out of scope:** Daemon PTY terminal auth and environment-variable secret references. Track those as ADR-0006 follow-up work after the minimal browser-first path.

**Implemented:** Agent-managed ACP authentication now has durable operation history, explicit method validation, cancellation, daemon-restart interruption handling, automatic readiness re-probing, and browser controls for progress, retry, and failure recovery. Terminal and environment-variable methods remain explicitly unsupported in this slice.

## [x] Slice 6: Create A Thread With An Installed Agent

**Depends on:** Slices 1, 4, and 5. No-auth agents may exercise the path without Slice 5 state.

**Goal:** Existing chat behavior uses installed-agent identity instead of direct role-command configuration.

**User-visible result:** In a selected repository, the user creates a thread with a ready installed agent, sees its exact ID and version, sends a prompt, receives streamed events, and retains the transcript across refresh. Installing a newer version does not alter the old thread.

**Implementation:**

- Change thread creation and storage to reference repository ID, installed agent ID, and resolved agent version.
- Validate readiness before starting a new execution while keeping old threads inspectable if an installation is later removed.
- Replace `/api/chat-agents` and role-derived agent choices with installed-agent inventory APIs.
- Remove `createConfiguredAgent("builder")` and direct role-command resolution from interactive chat.
- Preserve current files, attachments, streaming, retry, cancellation, and permission behavior during this migration.
- Make the UI show installed version and readiness next to agent selection and thread identity.
- Gate attachments and other controls using persisted negotiated capabilities.

**Acceptance:**

- A ready installed agent can create and run a thread without `~/.marshal/config.json` role commands.
- An unready, failed, or removed installation cannot start a new turn and produces a stable machine error code.
- Existing messages remain readable after daemon and browser restart.
- Installing another version leaves the existing thread's agent version unchanged.
- Existing chat API and pure frontend behavior remain covered.

**Likely areas:** `src/chat/`, `src/daemon/chat-turn.ts`, agent APIs, storage schema, `web/src/chat/`, chat API and store tests.

**Out of scope:** ACP session resume after daemon restart; Slice 7 owns durable session supervision.

**Implemented:** Chat threads persist repository ownership plus exact installed agent ID/version. Production thread creation and turns resolve only the machine-scoped installed launch specification and require `installed` plus `ready`; the legacy `/api/chat-agents` role-command path and interactive `createConfiguredAgent("builder")` fallback are removed. The browser selector uses the installed-agent inventory, shows version/readiness context, gates new threads to ready agents, and preserves capability-aware image behavior. Injected agents remain a test-only seam for chat protocol coverage.

## [x] Slice 7: Supervise Interactive ACP Sessions Durably

**Depends on:** Slice 6.

**Goal:** Interactive threads prove the shared ACP process/session supervisor described by ADR-0007.

**User-visible result:** Thread execution has explicit running, cancelled, failed, interrupted, and recoverable states. ACP events are durable before broadcast. A daemon restart never silently replays a prompt or pretends an interrupted session succeeded.

**Implementation:**

- Create explicit ACP process, connection, session, prompt, timeout, and diagnostic components behind one supervisor.
- Add durable session records with owner type/ID, installed agent ID/version, ACP session ID, capabilities, status, recovery metadata, and timestamps.
- Persist normalized events and original ACP payloads before broadcasting durable events.
- Move process/session ownership out of `ChatTurnRunner` and remove its in-memory session map.
- Implement bounded startup, prompt, idle, cancellation, and shutdown behavior.
- Reconcile sessions conservatively on daemon start. Resume only when negotiated capabilities, session identity, and installed version make it safe; otherwise record an inspectable interruption.
- Hydrate durable history over HTTP and use WebSocket only for live continuation.
- Keep process reuse out of scope unless correctness requires it.

**Acceptance:**

- Killing the daemon during a prompt leaves a durable interrupted state after restart.
- A non-resumable session is not silently retried.
- A resumable fake agent can load the recorded session when version and capabilities match.
- Cancellation records the user action and the observed agent/process outcome.
- Unknown ACP updates remain available as raw events instead of being discarded.

**Likely areas:** new `src/acp/` supervisor modules, session/event storage, `src/daemon/chat-turn.ts`, HTTP/WebSocket hydration, thread status UI, supervisor lifecycle tests.

**Out of scope:** Migrating factory runs; Slice 10 owns remaining consumers.

**Implemented:** Interactive chat now runs through a shared ACP supervisor with durable process/session/prompt/event records, raw and normalized event retention, bounded lifecycle operations, conservative restart interruption/reconciliation, durable HTTP event hydration, and WebSocket live continuation. Permission persistence remains on the existing chat broker for Slice 8.

## [x] Slice 8: Persist And Recover Permission Requests

**Depends on:** Slice 7.

**Goal:** The shared ACP supervisor routes all interactive permission requests through a durable daemon broker.

**User-visible result:** A permission request survives browser refresh, can be approved or denied exactly once, and shows pending, resolved, stale, cancelled, or interrupted state. Disconnecting never implies approval.

**Implementation:**

- Add durable `permission_requests` with session/thread ownership, original ACP request, options, status, selected option, and timestamps.
- Make the supervisor the only owner of ACP permission callbacks.
- Resolve options by ACP option kind and ID, never by array position or display text.
- Make decision mutations idempotent where practical and fail closed for stale or unrecognized choices.
- Reconcile unresolved requests on cancellation, thread deletion, process exit, and daemon restart.
- Generalize the current permission UI to render durable request state and available choices.
- State clearly in the UI and docs that an ACP permission is not process isolation.

**Acceptance:**

- Refreshing during a pending request preserves the request and its choices.
- Duplicate or stale decisions cannot approve another request.
- Process exit and daemon restart resolve or interrupt pending requests conservatively.
- Denial and cancellation reach the fake ACP agent with the expected outcome.

**Likely areas:** `src/permissions/`, existing permission broker migration, storage schema, supervisor, permission APIs, chat UI, broker and HTTP tests.

**Out of scope:** Workflow permission policy; Slice 9 introduces it with assignments.

**Implemented:** Interactive ACP permission callbacks are owned by the shared supervisor and persisted in durable `permission_requests` records. Browser decisions resolve ACP option kinds and IDs fail-closed and idempotently; cancellation, deletion, process exit, and restart reconcile unresolved requests without implying approval. The browser renders durable pending choices and explicitly distinguishes permission mediation from process isolation.

## [ ] Slice 9: Configure Workflow Profiles In The Browser

**Depends on:** Slices 1, 4, and 6.

**Goal:** Builder, validator, and spec-author become repository-scoped assignments of installed agents, not executable configuration types.

**User-visible result:** A user creates a workflow profile for the selected repository, assigns ready installed agents to roles, chooses supported model/mode settings, configures permission policy and deterministic verification commands, and saves without starting work.

**Implementation:**

- Add `workflow_profiles` and `agent_assignments` with repository ownership.
- Store installed agent references plus optional negotiated ACP configuration. Do not copy launch commands, package specs, or registry URLs into assignments.
- Add explicit permission policy, timeout/retry settings, verification commands, and builder/validator decorrelation policy.
- Validate readiness and capabilities at save time and again at execution time.
- Add workflow profile CRUD APIs and a browser profile editor.
- Display the trust distinction between assigning an agent and authorizing unattended execution.
- Leave current factory execution on its old path until Slice 10, but prevent new UI configuration from writing legacy command roles.

**Acceptance:**

- The same installed agent can fill multiple roles when policy permits.
- A decorrelation rule can reject the same builder and validator assignment.
- Removed, unready, or capability-incompatible agents produce clear validation errors.
- Saving a profile does not spawn an agent or start a task.
- Profiles remain repository-scoped when switching repositories.

**Likely areas:** `src/workflows/`, storage schema, daemon workflow-profile APIs, `web/src/workflows/`, assignment validation tests and frontend pure-logic tests.

**Out of scope:** Executing profiles and strong sandbox implementation.

## [ ] Slice 10: Author And Freeze A Profile-Backed Task

**Depends on:** Slices 7, 8, and 9.

**Goal:** The first factory consumer uses a workflow-profile assignment and the shared supervisor without also rewriting build and validation in the same change.

**User-visible result:** A user starts specification authoring with the profile's spec-author assignment, reviews the durable conversation, creates a repository-scoped task, and freezes its specification in the task worktree. The browser shows the exact agent version and session evidence used.

**Implementation:**

- Migrate spec-author execution to resolve the selected profile assignment to installed agent ID/version.
- Use the shared supervisor for spawn, initialize, prompt, events, cancellation, diagnostics, and permissions.
- Persist exact agent ID/version, capability snapshot, session ID, assignment configuration, and operation history for the authoring session.
- Create the task through browser and daemon APIs with repository and workflow-profile ownership.
- Preserve the existing human-owned freeze boundary: the reviewed specification is committed into the task worktree before unattended build execution is possible.
- Apply workflow permission policy to the spec-author session and fail closed when it cannot safely resolve a request.
- Remove direct `specAuthor` command resolution after the profile-backed path is complete.

**Acceptance:**

- A fake installed spec-author can create a durable browser conversation and a frozen task specification.
- Updating the installed spec-author later does not rewrite the authoring session or task provenance.
- A workflow permission request follows the configured policy and an unsafe/unmatched request fails closed.
- The task cannot enter unattended building before the user freezes the specification.
- Existing task freeze and worktree tests remain green.

**Likely areas:** `src/daemon/spec-chat.ts`, `src/workflows/`, task/spec storage, supervisor and permissions, spec-author and task UI, freeze and end-to-end tests.

**Out of scope:** Builder and validator migration, merge, containers/VMs, spend budgets.

## [ ] Slice 11: Build Validate Review And Merge Through The Supervisor

**Depends on:** Slice 10.

**Goal:** Builder and validator use the same installed-agent inventory, ACP supervisor, event model, and permission mediation as chat and spec authoring.

**User-visible result:** A frozen task runs through build and validation using its workflow profile. The browser shows exact agent versions, sessions, events, checks, commits, retries, and failures. The human reviews and merges or sends the task back.

**Implementation:**

- Migrate builder and validator consumers to independently resolve profile assignments to installed agent ID/version.
- Create a fresh workflow ACP session per attempt in the task worktree.
- Use the shared supervisor for spawn, initialize, prompt, events, cancellation, diagnostics, and permissions.
- Persist exact agent ID/version, capability snapshot, session ID, assignment configuration, and operation history on every run.
- Implement workflow permission-policy resolution through the central broker; fail closed when policy cannot safely select an option.
- Preserve existing worktree lifecycle, retries, review evidence, diff, merge, cleanup, and failed-worktree inspection behavior.
- Keep deterministic verification commands as the authoritative pass/fail gate. Agent narrative remains evidence.
- Re-enable or complete task/review navigation in the application shell so normal operation is browser-based.
- Remove builder/validator role-specific agent factories after migration.

**Acceptance:**

- An end-to-end fake-agent test runs a browser-created task through build, validation, review, and merge.
- Builder and validator have independently resolved assignments and fresh sessions.
- Updating an installed agent does not rewrite historical run identity.
- A workflow permission request follows the configured policy and an unsafe/unmatched request fails closed.
- Existing retry, deterministic gate, diff, merge, and failed-worktree inspection behavior remains green.

**Likely areas:** `src/daemon/orchestrator.ts`, `src/workflows/`, run/event storage, supervisor and permissions, task/review UI, orchestrator and end-to-end tests.

**Out of scope:** Containers/VMs, spend budgets, concurrent task policy, auto-merge.

## [ ] Slice 12: Remove Legacy Product Paths And Finish Diagnostics

**Depends on:** Slice 11.

**Goal:** The supported product matches ADR-0005 rather than retaining two onboarding and configuration systems.

**User-visible result:** The web application contains repository, agent, thread, workflow, task, review, and system diagnostics. The supported CLI is limited to daemon lifecycle and inspection. Current documentation describes browser-first setup only.

**Implementation:**

- Narrow the supported CLI to `marshal start`, `marshal stop`, and `marshal status`. Keep development/recovery commands only when they have a concrete remaining need and label them accordingly.
- Remove normal-product dependencies on `marshal init`, role command configuration, and direct executable defaults.
- Delete `createConfiguredAgent`, role-specific command resolution, and obsolete `/api/chat-agents` behavior once no consumer remains.
- Add browser diagnostics for daemon state, repository validation, registry freshness, installation failures, authentication, readiness, ACP process/session failures, and durable operations.
- Ensure errors expose a stable machine code and actionable human message.
- Update `README.md` and rewrite `docs/HUMAN-TESTING-GUIDE.md` around the browser-first journey.
- Add a regression smoke test proving a clean user can complete the minimal browser flow without editing configuration.

**Acceptance:**

- Searching current product code and docs finds no normal flow that requires direct role commands.
- CLI smoke tests cover start, stop, and status; removed commands are absent or explicitly development-only.
- The human testing guide covers setup through review and includes refresh/restart recovery checks.
- A clean-state integration test proves repository registration, catalog load, pinned install, readiness, chat, assignment, and workflow execution.

**Likely areas:** `src/cli.ts`, `src/setup/`, `src/agent/configured-agent.ts`, config types, daemon diagnostics APIs, `web/src/settings/`, README and human testing guide, smoke tests.

## Follow-Up Work After ADR-0005

These items are required by the broader target architecture but should not inflate the minimal ADR-0005 migration slices:

- Binary installation with SHA-256 verification, archive safety, extraction limits, and atomic publication.
- Version-pinned `uvx` installation.
- Agent updates, side-by-side installed versions, removal policy, and provenance UI hardening.
- Terminal authentication through a daemon PTY and browser terminal.
- Environment-variable authentication backed by OS credential storage or explicit external secret references.
- Custom/local ACP agents and private registry sources.
- Session fork/load/close controls beyond the minimal recovery path.
- Isolated interactive workspaces.
- Container, VM, or OS sandbox execution profiles.
- Spend/resource budgets and concurrent workflow policy.

## Dependency Summary

```text
1 Repository registration
  -> 2 Registry catalog
    -> 3 Pinned installation
      -> 4 Readiness and capabilities
        -> 5 Agent-managed authentication
        -> 6 Installed-agent chat
          -> 7 Shared session supervisor
            -> 8 Durable permissions

1 + 4 + 6
  -> 9 Workflow profiles

7 + 8 + 9
  -> 10 Profile-backed spec and freeze
    -> 11 Build, validate, review, and merge
      -> 12 Legacy cleanup and diagnostics
```

Slices 5 and 6 may proceed in parallel after Slice 4 if the chat path initially uses a no-auth agent. Slice 9 can begin after installed-agent chat proves the identity model, but Slice 10 must wait for the supervisor and durable permission broker.
