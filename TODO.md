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

### 11. Verify the complete ADR lifecycle

- [x] Add focused coverage for distribution selection precedence: checksummed compatible binary, exact `npx`, exact `uvx`, and explicit user override. (Selection and exact package-pin coverage added; the remaining lifecycle checks are tracked below.)
- [x] Cover checksum match, mismatch, checksumless policy, unsafe archive entries, extraction limits, executable containment, and no-shell launch. (Focused binary integrity, policy, containment, archive, and launch coverage added.)
- [x] Cover atomic publication, interrupted-operation recovery, stale temporary cleanup, duplicate requests, cancellation, and retry. (Focused installer, API, and frontend state coverage covers all lifecycle states.)
- [x] Cover side-by-side versions, default selection, update immutability, active-reference removal conflicts, payload cleanup, and historical provenance. (Existing focused coverage covers these areas.)
- [x] Cover API and WebSocket recovery after browser refresh and daemon restart. (HTTP hydration after durable reconciliation and WebSocket reconnect hydration are covered against durable state.)
- [x] Run `pnpm run check`, `pnpm run test`, and the relevant daemon/API integration tests before considering ADR-0008 implemented. (`pnpm run check`, full `pnpm run test`, and focused installer/API/WebSocket/frontend tests passed.)

## ADR-0012: Consolidated Daemon Storage

Implement the ADR as the following dependency-ordered vertical slices. Each slice should leave the daemon and browser usable, keep repository ownership explicit, and avoid dual-writing old and new layouts. This is a pre-1.0 reset-based cutover: do not add a split-database import unless a concrete deployed dataset is approved separately, and never scan arbitrary repository `.marshal` directories. Artifacts do not have a current file store, so this plan does not create an otherwise-unused artifact subsystem; any future artifact implementation must use the repository namespace defined here.

### 1. Establish one daemon storage contract

 - [x] Add one storage-layout module that resolves `MARSHAL_HOME`, defaults to `~/.marshal`, and owns paths for `marshal.db`, installations, credentials, repository namespaces, logs, temporary files, and daemon lifecycle metadata.
 - [x] Route existing installation, credential, PID, port, and other daemon-owned file access through that module instead of constructing paths in feature modules.
 - [x] Keep registered checkout paths available only for source files, git operations, and repository-owned inputs such as `marshal.json` and `.worktreeinclude`.
 - [x] Require daemon-generated or closed-set validated identifiers for namespace components and prove all resolved paths remain inside `MARSHAL_HOME`.
 - [x] Add focused tests for the default root, absolute and relative `MARSHAL_HOME` overrides, directory creation, sensitive-directory permissions, and path containment.

### 2. Make the interactive workbench repository-ID scoped

 - [x] Introduce an explicit repository context resolved from a registered repository ID; the selected repository remains a browser convenience, not an implicit persistence selector.
 - [x] Change thread, message, attachment-metadata, ACP session, prompt, event, and permission stores to require repository identity on every repository-scoped read and mutation.
 - [x] Make repository ownership immutable at record creation and stop using `repo_root` as the authorization or query boundary; retain checkout and working-directory paths only as execution metadata.
 - [x] Update HTTP, WebSocket hydration, chat runners, and browser queries to carry or resolve the repository ID explicitly and reject cross-repository resource access.
 - [x] Add two-repository tests for isolated thread lists, messages, sessions, permissions, attachment metadata, repository switching, and cross-scope 404 or conflict behavior.

### 3. Make factory workflows repository-ID scoped

- [x] Change task, spec-message, spec-author session, run, run-operation, run-event, workflow-profile, and assignment stores to require repository identity explicitly. (Factory stores and execution paths now use repository-leading queries; legacy direct seams remain only for pre-Slice-3 CLI/unit fixtures.)
- [x] Scope task slugs, task lookup, transitions, run history, scheduler selection, and WebSocket snapshots by repository so two repositories may use the same slug safely. (Scheduler, run/event payloads, connected snapshots, and browser projections carry repository identity.)
- [x] Resolve the checkout path from the immutable repository ID only when source, git, agent-session, or worktree execution needs it.
- [x] Update task, spec, run, workflow-profile, and board APIs plus browser query keys and mutations to preserve repository ownership end to end. (Explicit query/header repository resolution and repository-leading web keys/mutations are covered.)
- [x] Add two-repository tests covering identical task slugs, independent workflow profiles, scheduler isolation, run/event ownership, and rejected cross-repository mutations.

### 4. Cut fresh installations over to one `marshal.db`

- [x] Merge the machine and repository Drizzle schemas into one authoritative schema, one Drizzle configuration, one ordered migration directory, and one migration journal.
- [x] Define the repository-ownership matrix and add required non-null `repository_id` columns, foreign keys, composite ownership constraints where needed, and repository-leading indexes to every repository-scoped table.
- [x] Replace `openMachineDb` and repository-path-derived `openDb` behavior with one controlled daemon database open at `$MARSHAL_HOME/marshal.db`; run migrations before routes, stores, reconciliation, or background work start.
- [x] Preserve parameterized raw SQL where it remains clear, but move all schema mutation and backfill logic into checked-in migrations.
- [x] Implement the reset-only legacy contract: never open or import `machine.db` or `<repository>/.marshal/state.db`, never dual-read or dual-write them, and surface stable reset guidance for a recognized old machine layout.
- [x] Remove the split schemas, migration streams, Drizzle configs, and packaged migration paths only after every active store uses `marshal.db`.
- [x] Test empty initialization, packaged migration discovery, unknown-newer migration rejection, transactional migration failure, `PRAGMA integrity_check`, and `PRAGMA foreign_key_check`.

### 5. Move attachment bytes into daemon-owned repository namespaces

 - [x] Store attachment bytes beneath `$MARSHAL_HOME/repositories/<repository-id>/attachments/` using daemon-generated attachment and thread identifiers, with no repository name, checkout path, filename, or other client-provided path component. (Opaque UUID keys and repository/thread-scoped daemon namespaces are enforced by `attachment-storage.ts`.)
 - [x] Keep attachment ownership, quota, MIME validation, byte size, and opaque storage key in `marshal.db`; never persist an absolute checkout-derived path. (HTTP upload/download/list routes resolve repository ownership explicitly and expose only attachment metadata.)
 - [x] Define bounded file/database write ordering so a failed metadata insert removes the new file and a failed file deletion remains discoverable for retry. (Upload writes bytes before metadata with orphan cleanup; deletion removes bytes before deleting thread metadata.)
 - [x] Add startup or maintenance reconciliation for orphaned attachment files and missing-file metadata without weakening repository access checks. (Daemon startup/cycles and HTTP startup reconcile only the daemon namespace; missing bytes remain a scoped 404.)
 - [x] Test upload, read, quota enforcement, thread deletion cleanup, interrupted cleanup recovery, a moved or read-only checkout, and path-containment attacks. (Focused storage and daemon API coverage includes MIME/signature/size limits, cross-repository 404s, cleanup retry, relocation/read-only checkouts, and hostile storage keys.)

### 6. Move task worktrees into stable repository namespaces

 - [x] Make `WorktreeManager` require both repository ID and checkout path, and place worktrees beneath `$MARSHAL_HOME/repositories/<repository-id>/worktrees/<worktree-id>`.
 - [x] Use a daemon-generated worktree ID for the directory name; keep task slug, branch, descriptor, source checkout, and timestamps as metadata rather than path components.
 - [x] Replace repository-local `worktrees.json` and checkout-path hashes with durable worktree records in `marshal.db` that support create, reuse, inspect, destroy, and restart recovery.
 - [x] Continue reading `marshal.json` and `.worktreeinclude` from the source checkout while ensuring setup, build, validation, diff, merge, and cleanup use the centralized worktree record.
 - [x] Add tests for restart reuse, explicit cleanup, failed setup recovery, duplicate repository names, malicious task slugs, checkout relocation, and no writes to the source checkout.

### 7. Define repository removal and retained-history behavior

- [x] Change ordinary repository removal to unregister the checkout, clear it as the selected repository, and retain its database history and daemon-owned file namespace by stable repository ID.
- [x] Make unavailable, moved, and unregistered checkouts inspectable in repository diagnostics while blocking source-dependent actions with stable, actionable errors.
- [x] Allow an existing retained repository identity to be reconnected to a valid checkout path without rewriting historical ownership.
- [x] Keep irreversible purge out of ordinary removal; if a purge flow is introduced, make it explicit, durable, idempotent, and recoverable across database and filesystem cleanup.
- [x] Test unregister, re-selection prevention, retained threads and runs, missing checkout behavior, reconnection, file retention, and foreign-key integrity.

### 8. Remove repository-local daemon state and expose the operational boundary

 - [x] Delete repository-state initialization, `getRepoStateDir`, `.marshal/state.db`, `.marshal/worktrees.json`, repository-local attachment paths, and legacy-state scanning once their replacements are active.
 - [x] Retire recovery/setup behavior and tests that create a repository `.marshal` directory; keep source configuration files explicitly separate from daemon state.
 - [x] Audit every daemon filesystem write and prove all durable output is beneath the resolved `MARSHAL_HOME` or an explicitly temporary OS directory used only before atomic publication.
 - [x] Extend the diagnostics API and browser page with the resolved storage root, database path, repository namespace status, custom-home status, and actionable legacy-layout or integrity failures.
 - [x] Document backup, restore, persistent-volume mounting, stopped-daemon reset, SQLite live-backup constraints, and the pre-1.0 split-layout reset in the README and operator/development guidance.
 - [x] Add tests proving registered read-only and ephemeral checkouts work for non-mutating flows and no daemon operation creates `<repository>/.marshal`.

### 9. Verify the complete consolidated-storage lifecycle

- [x] Exercise a custom `MARSHAL_HOME` through repository registration, agent installation and credentials, chat with attachments, task creation, worktree execution, restart recovery, and repository unregister/reconnect. (Daemon/API lifecycle coverage uses a fake ACP client and file-backed credential store; real third-party authenticated-agent browser flows are intentionally outside the safe automated boundary.)
- [x] Assert a fresh installation creates one `marshal.db`, one migration journal, and no `machine.db`, `state.db`, or repository-local Marshal state. (Fresh initialization and reset assertions cover the five-entry migration journal and exact top-level layout.)
- [x] Cover repository foreign-key and query isolation for every active workbench and factory resource, including duplicate slugs and selected-repository changes. (Composite permission ownership is enforced by migration and daemon/API plus pure frontend repository-key coverage.)
- [x] Cover attachment and worktree write-order failures, orphan reconciliation, retained-history semantics, source-checkout deletion, and fresh-install reset behavior. (Focused attachment/worktree, lifecycle, retention, reconciliation, and migration tests cover these boundaries.)
- [x] Run `pnpm run check`, `pnpm run test`, and the daemon/browser verification flow before considering ADR-0012 implemented. (Type-check, focused daemon/API/storage tests, full daemon tests, build, and frontend tests passed; browser verification was intentionally not rerun per the one-time verification request.)

**ADR-0012 overall:** [x] Complete. Consolidated daemon storage is exercised through the daemon/API and pure frontend repository interfaces; real third-party authenticated-agent browser/OAuth execution remains an intentional manual boundary and is not claimed by the fake-agent tests.
