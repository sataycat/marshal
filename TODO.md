# TODO

## ADR-0008: Secure and Extensible Agent Installations

Break the proposed ADR into the following dependency-ordered vertical slices. Each slice should leave the product in a usable state and include the daemon, API, browser flow, and focused tests needed to prove the behavior it adds.

### 1. Generalize the installed-agent contract

- [x] Replace the `npx`-only installed-agent and launch-spec types with a distribution-neutral contract for `binary`, `npx`, and `uvx`.
- [x] Add an immutable installation identity and provenance shape covering the exact version, distribution, source, package or archive identity, registry snapshot, installation root, and integrity state.
- [x] Add explicit integrity states for verified, unverified, mismatch, not-applicable, and unknown artifacts.
- [x] Migrate machine storage without losing existing `agent_id` and `agent_version` references used by threads, sessions, assignments, and runs.
- [x] Keep ACP startup dependent only on a validated local launch specification; it must not resolve registry metadata or install packages.
- [x] Add storage and launch-resolution tests proving the current `npx` path still works through the generalized contract.

### 2. Validate complete distribution metadata

- [x] Preserve and validate binary distribution records instead of reducing them to platform names.
- [x] Validate platform, archive URL and format, checksum, executable path, arguments, and optional environment metadata at the registry boundary.
- [x] Reject unsafe executable paths, malformed checksums, unsupported platforms, and invalid URLs before installation.
- [x] Add a daemon install-candidate response that reports the exact version, source, license, selected distribution, checksum, integrity policy, and installation risk.
- [x] Keep package arguments, archive URLs, executable paths, and local paths out of ordinary thread and workflow configuration.
- [x] Add registry fixtures and parser tests for `npx`, `uvx`, checksummed binaries, checksumless binaries, malformed metadata, and safe unknown fields.

### 3. Materialize exact `uvx` installations

- [x] Add exact-version `uvx` package validation with the same moving-alias protections as `npx`.
- [x] Implement a distribution adapter that invokes `uvx` without shell interpolation and records the exact package specifier.
- [x] Resolve and persist a launch specification that the shared ACP supervisor can consume without installing at process start.
- [x] Let the install API accept an explicit distribution and select `uvx` when it is the chosen or supported fallback.
- [x] Update the Agents area so a `uvx`-only agent can be installed, probed, authenticated, and selected for a thread or workflow.
- [x] Add installer, API, readiness, and downstream thread/workflow tests for a `uvx` agent.

### 4. Secure binary installation

- [x] Download compatible binary archives into daemon-owned temporary directories with bounded size, timeout, and redirect handling.
- [x] Verify declared SHA-256 checksums and persist expected and observed digests.
- [x] Define and enforce the checksumless-binary policy; require explicit confirmation if unverified binaries are allowed to execute.
- [x] Extract archives only after validating entry count, expanded size, and compression ratio limits.
- [x] Reject absolute paths, traversal paths, symlinks, hard links, device files, and unsupported archive entries.
- [x] Resolve the declared executable strictly within the installation root and launch it through the existing no-shell ACP path.
- [x] Add archive fixtures and tests for successful installation, checksum mismatch, unsafe paths and links, extraction limits, executable containment, and probe startup.

### 5. Publish and recover installations atomically

- [x] Give every install attempt a unique temporary root and write a complete manifest before publication.
- [x] Atomically rename only a fully validated installation into `~/.marshal/agents/<agent-id>/<version>/<installation-id>`.
- [x] Mark an installed-agent record selectable only after the published root and manifest are complete.
- [x] Persist installation phases and recovery metadata sufficient to distinguish pre-publication failure from a completed publication.
- [x] Reconcile active installation operations during daemon startup: promote only proven complete artifacts, mark the rest interrupted or failed, and clean temporary or partial roots.
- [x] Make duplicate requests for the same agent, exact version, distribution, and installation identity reuse the existing operation or completed record.
- [x] Add failure, restart, cleanup, atomic-publication, and duplicate-request tests.

### 6. Make installation operations durable in the browser

- [x] Extend installation operations with stable phases such as resolving, downloading, verifying, extracting, publishing, completed, failed, and interrupted.
- [x] Persist actionable diagnostics and stable machine error codes for each terminal failure.
- [x] Publish installation operation updates through the daemon event bus and WebSocket, while retaining HTTP polling as the hydration and recovery path.
- [x] Make `GET /api/agents/operations/:id` return the durable operation state after a browser refresh or daemon restart.
- [x] Use the existing installation query in the Agents route and stop polling when the operation reaches a terminal state.
- [x] Add cancellation only if it guarantees bounded cleanup and cannot expose a partial installation. (Daemon-level cancellation marks the durable operation interrupted before cleanup, removes its temporary root, prevents publication, and preserves retryability. External package-manager work may finish in its own process, but can no longer publish Marshal state.)
- [x] Add API, WebSocket, and pure frontend state tests for progress, reconnect, terminal states, and retry behavior.

### 7. Add side-by-side versions and explicit updates

- [x] Treat update as a new immutable installation operation and artifact rather than in-place mutation.
- [x] Allow multiple distributions and versions of one agent to coexist with an idempotency key that includes distribution and installation identity.
- [x] Add an explicit update API and a machine-scoped default selection for future threads and workflow assignments.
- [x] Group installed versions by agent in the Agents area and show distribution, integrity, provenance, readiness, and the selected default.
- [x] Keep existing thread, session, assignment, and run records pinned to their original installed identity and version.
- [x] Let chat and workflow selectors use the default while still permitting an explicit installed version choice.
- [x] Add tests proving an update leaves the old version launchable and historical records unchanged.

### 8. Preserve historical provenance independently of installation rows

- [x] Persist an installation identity or compact immutable provenance snapshot on threads, ACP sessions, workflow assignments, spec-author sessions, and runs when they are created.
- [x] Include distribution, exact package or archive identity, integrity result, and registry provenance in historical execution records.
- [x] Keep historical APIs readable without resolving a removed installed-agent row.
- [x] Define migration behavior for existing records that only contain `agent_id` and `agent_version`.
- [x] Add tests proving thread, session, run, assignment, and the closest available artifact history (chat attachment metadata) remains inspectable after an installed version is removed; this codebase has no separate agent artifact model yet.

### 9. Guard removal and clean up owned payloads

- [x] Inspect active ACP sessions, recoverable sessions, active authentication/install operations, workflow assignments, and default selections before removal.
- [x] Distinguish blocking live references from non-blocking historical references and return actionable machine error codes with reference details.
- [x] Replace synchronous row deletion with a durable remove operation that tracks cleanup and failure state.
- [x] Prevent removal of an installation needed by an active or recoverable process unless the conflict is explicitly resolved.
- [x] Remove only Marshal-owned installation material and metadata; never remove repository files or historical evidence.
- [x] Preserve a tombstone or provenance record so a removed identity remains distinguishable from a never-installed agent.
- [x] Make removal idempotent and expose conflict, retry, and cleanup states in the Agents area.
- [x] Add tests for active-session and recoverable-session conflicts, workflow/default reassignment conflicts, authentication/install conflicts, successful owned-payload deletion, cleanup failure/retry, idempotency, and historical readability; pure frontend error handling covers removal conflict and cleanup retry messaging without adding Slice 10 UI behavior.

### 10. Finish the browser trust and lifecycle experience

- [x] Separate catalog entries, installed versions, and durable install/update/remove operations in the Agents area.
- [x] Before install or update, show the exact version, source, distribution, license, checksum/integrity status, and requested trust transition.
- [x] Show clear states for verified, unverified, mismatch, failed, interrupted, installing, installed, ready, and authentication-required versions.
- [x] Add distribution selection where more than one supported option is available, while retaining daemon-side selection validation.
- [x] Show installed versions that are absent from the current registry snapshot.
- [x] Keep launch internals limited to scoped diagnostics rather than ordinary product configuration.
- [x] Verify capability and readiness controls continue to work for binary, `npx`, and `uvx` installations.
- [x] Update `docs/HUMAN-TESTING-GUIDE.md` with install, integrity, update, restart-recovery, side-by-side, and removal-conflict flows.

### 11. Verify the complete ADR lifecycle

- [x] Add focused coverage for distribution selection precedence: checksummed compatible binary, exact `npx`, exact `uvx`, and explicit user override. (Selection and exact package-pin coverage added; the remaining lifecycle checks are tracked below.)
- [x] Cover checksum match, mismatch, checksumless policy, unsafe archive entries, extraction limits, executable containment, and no-shell launch. (Focused binary integrity, policy, containment, archive, and launch coverage added.)
- [x] Cover atomic publication, interrupted-operation recovery, stale temporary cleanup, duplicate requests, cancellation, and retry. (Focused installer, API, and frontend state coverage covers all lifecycle states.)
- [x] Cover side-by-side versions, default selection, update immutability, active-reference removal conflicts, payload cleanup, and historical provenance. (Existing focused coverage covers these areas.)
- [x] Cover API and WebSocket recovery after browser refresh and daemon restart. (HTTP hydration after durable reconciliation and WebSocket reconnect hydration are covered against durable state.)
- [x] Run `pnpm run check`, `pnpm run test`, and the relevant daemon/API integration tests before considering ADR-0008 implemented. (`pnpm run check`, full `pnpm run test`, and focused installer/API/WebSocket/frontend tests passed.)
