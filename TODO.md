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
- [ ] Add installer, API, readiness, and downstream thread/workflow tests for a `uvx` agent.

### 4. Secure binary installation

- [ ] Download compatible binary archives into daemon-owned temporary directories with bounded size, timeout, and redirect handling.
- [ ] Verify declared SHA-256 checksums and persist expected and observed digests.
- [ ] Define and enforce the checksumless-binary policy; require explicit confirmation if unverified binaries are allowed to execute.
- [ ] Extract archives only after validating entry count, expanded size, and compression ratio limits.
- [ ] Reject absolute paths, traversal paths, symlinks, hard links, device files, and unsupported archive entries.
- [ ] Resolve the declared executable strictly within the installation root and launch it through the existing no-shell ACP path.
- [ ] Add archive fixtures and tests for successful installation, checksum mismatch, unsafe paths and links, extraction limits, executable containment, and probe startup.

### 5. Publish and recover installations atomically

- [ ] Give every install attempt a unique temporary root and write a complete manifest before publication.
- [ ] Atomically rename only a fully validated installation into `~/.marshal/agents/<agent-id>/<version>/<installation-id>`.
- [ ] Mark an installed-agent record selectable only after the published root and manifest are complete.
- [ ] Persist installation phases and recovery metadata sufficient to distinguish pre-publication failure from a completed publication.
- [ ] Reconcile active installation operations during daemon startup: promote only proven complete artifacts, mark the rest interrupted or failed, and clean temporary or partial roots.
- [ ] Make duplicate requests for the same agent, exact version, distribution, and installation identity reuse the existing operation or completed record.
- [ ] Add failure, restart, cleanup, atomic-publication, and duplicate-request tests.

### 6. Make installation operations durable in the browser

- [ ] Extend installation operations with stable phases such as resolving, downloading, verifying, extracting, publishing, completed, failed, and interrupted.
- [ ] Persist actionable diagnostics and stable machine error codes for each terminal failure.
- [ ] Publish installation operation updates through the daemon event bus and WebSocket, while retaining HTTP polling as the hydration and recovery path.
- [ ] Make `GET /api/agents/operations/:id` return the durable operation state after a browser refresh or daemon restart.
- [ ] Use the existing installation query in the Agents route and stop polling when the operation reaches a terminal state.
- [ ] Add cancellation only if it guarantees bounded cleanup and cannot expose a partial installation.
- [ ] Add API, WebSocket, and pure frontend state tests for progress, reconnect, terminal states, and retry behavior.

### 7. Add side-by-side versions and explicit updates

- [ ] Treat update as a new immutable installation operation and artifact rather than in-place mutation.
- [ ] Allow multiple distributions and versions of one agent to coexist with an idempotency key that includes distribution and installation identity.
- [ ] Add an explicit update API and a machine-scoped default selection for future threads and workflow assignments.
- [ ] Group installed versions by agent in the Agents area and show distribution, integrity, provenance, readiness, and the selected default.
- [ ] Keep existing thread, session, assignment, and run records pinned to their original installed identity and version.
- [ ] Let chat and workflow selectors use the default while still permitting an explicit installed version choice.
- [ ] Add tests proving an update leaves the old version launchable and historical records unchanged.

### 8. Preserve historical provenance independently of installation rows

- [ ] Persist an installation identity or compact immutable provenance snapshot on threads, ACP sessions, workflow assignments, spec-author sessions, and runs when they are created.
- [ ] Include distribution, exact package or archive identity, integrity result, and registry provenance in historical execution records.
- [ ] Keep historical APIs readable without resolving a removed installed-agent row.
- [ ] Define migration behavior for existing records that only contain `agent_id` and `agent_version`.
- [ ] Add tests proving thread, session, run, assignment, and artifact history remains inspectable after an installed version is removed.

### 9. Guard removal and clean up owned payloads

- [ ] Inspect active ACP sessions, recoverable sessions, active authentication/install operations, workflow assignments, and default selections before removal.
- [ ] Distinguish blocking live references from non-blocking historical references and return actionable machine error codes with reference details.
- [ ] Replace synchronous row deletion with a durable remove operation that tracks cleanup and failure state.
- [ ] Prevent removal of an installation needed by an active or recoverable process unless the conflict is explicitly resolved.
- [ ] Remove only Marshal-owned installation material and metadata; never remove repository files or historical evidence.
- [ ] Preserve a tombstone or provenance record so a removed identity remains distinguishable from a never-installed agent.
- [ ] Make removal idempotent and expose conflict, retry, and cleanup states in the Agents area.
- [ ] Add tests for active-session conflicts, workflow reassignment, authentication conflicts, successful payload deletion, cleanup failure, and historical readability.

### 10. Finish the browser trust and lifecycle experience

- [ ] Separate catalog entries, installed versions, and durable install/update/remove operations in the Agents area.
- [ ] Before install or update, show the exact version, source, distribution, license, checksum/integrity status, and requested trust transition.
- [ ] Show clear states for verified, unverified, mismatch, failed, interrupted, installing, installed, ready, and authentication-required versions.
- [ ] Add distribution selection where more than one supported option is available, while retaining daemon-side selection validation.
- [ ] Show installed versions that are absent from the current registry snapshot.
- [ ] Keep launch internals limited to scoped diagnostics rather than ordinary product configuration.
- [ ] Verify capability and readiness controls continue to work for binary, `npx`, and `uvx` installations.
- [ ] Update `docs/HUMAN-TESTING-GUIDE.md` with install, integrity, update, restart-recovery, side-by-side, and removal-conflict flows.

### 11. Verify the complete ADR lifecycle

- [ ] Add focused coverage for distribution selection precedence: checksummed compatible binary, exact `npx`, exact `uvx`, and explicit user override.
- [ ] Cover checksum match, mismatch, checksumless policy, unsafe archive entries, extraction limits, executable containment, and no-shell launch.
- [ ] Cover atomic publication, interrupted-operation recovery, stale temporary cleanup, duplicate requests, cancellation, and retry.
- [ ] Cover side-by-side versions, default selection, update immutability, active-reference removal conflicts, payload cleanup, and historical provenance.
- [ ] Cover API and WebSocket recovery after browser refresh and daemon restart.
- [ ] Run `pnpm run check`, `pnpm run test`, and the relevant daemon/API integration tests before considering ADR-0008 implemented.
