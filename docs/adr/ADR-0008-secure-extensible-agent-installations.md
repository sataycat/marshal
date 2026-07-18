# ADR-0008: Secure and Extensible Agent Installations

**Status:** Proposed  
**Date:** 2026-07-19  
**Parent:** ADR-0006  
**Related:** ADR-0005, ADR-0007

---

## Context

Marshal now has the browser-first agent lifecycle and uses installed-agent
identity throughout interactive threads and factory workflows. The current
implementation deliberately supports only one distribution path: an exact
version-pinned `npx` package.

That path establishes the product boundary, but it is not sufficient for the
target registry-backed architecture:

- Important ACP agents are distributed as platform-specific binaries.
- Some agents are distributed through `uvx` rather than `npx`.
- Installation is a remote-code-execution and supply-chain boundary, so
  checksums, archive safety, provenance, and atomic publication must be
  explicit rather than implied.
- Users need explicit updates and side-by-side versions without changing the
  identity of historical threads, sessions, or workflow runs.
- Removing an installed version must not invalidate historical evidence or
  break currently referenced product records without an actionable state.

ADR-0006 defines these requirements, but the initial migration deferred them
to keep the browser-first path narrow. Continuing to treat `npx` as the only
installation mechanism would make the initial implementation a permanent
constraint and would leave the most security-sensitive lifecycle decisions
implicit.

---

## Decision

Marshal will implement a secure, distribution-neutral installation pipeline
whose output is always the same daemon-owned installed-agent record and
resolved local launch specification, regardless of whether the source is a
binary archive, `npx`, or `uvx` distribution.

The next installation milestone consists of:

1. Platform-compatible binary installation with checksum verification and
   safe archive extraction.
2. Exact version-pinned `uvx` installation.
3. Explicit side-by-side installed versions and update actions.
4. Immutable provenance for historical thread, session, and workflow records.
5. Browser-visible integrity, provenance, update, and removal states.

The ACP supervisor continues to receive only a resolved local launch
specification. It must not fetch registry metadata, resolve mutable package
aliases, or install distributions while starting a process.

### Distribution selection

The daemon validates registry metadata before selecting a distribution. The
selection order remains:

1. Compatible binary with a declared checksum.
2. Exact version-pinned `npx` distribution.
3. Exact version-pinned `uvx` distribution.

The user may explicitly select another supported distribution. Marshal never
rewrites a registry version as `latest`, a range, or another moving alias.

### Binary installation safety

Binary installation will:

- Download into a daemon-owned temporary directory.
- Enforce response-size, timeout, and redirect limits.
- Verify SHA-256 when the registry declares a checksum.
- Represent checksumless binaries as unverified and require explicit policy
  handling before execution.
- Reject absolute paths, traversal paths, links, device files, and other
  unsafe archive entries.
- Enforce archive entry-count, expanded-size, and compression-ratio limits.
- Resolve the declared executable strictly within the installation root.
- Publish the completed version through an atomic rename only after all
  validation succeeds.
- Remove temporary and partial installation state after failure or restart.

Archives and registry-provided launch arguments are treated as untrusted
input. Extraction and process launch never use shell interpolation.

### Version identity and updates

An installed version is an immutable materialized artifact identified by its
agent ID, exact version, distribution, and installation identity. Updates are
new installation records, not in-place mutation of an existing version.

The daemon may retain multiple versions of the same agent side by side. New
threads, assignments, and workflow runs select one installed identity. An
update changes only the default selection offered for future product actions;
it never rewrites existing records.

Removal is guarded by reference inspection:

- Historical records remain readable after removal.
- Active sessions and running operations cannot lose their launch root.
- A version referenced by an active assignment or recoverable session cannot
  be removed without an explicit, actionable conflict response.
- Removing a version removes only Marshal-owned installation material and
  metadata, never repository files or historical evidence.

### Durable operations and recovery

Install, update, and remove actions use the existing durable-operation model.
After daemon restart, incomplete installation operations are reconciled as
failed or interrupted unless atomic publication proves that a complete
installed version exists. No partial directory is selectable as installed.

Duplicate requests for the same agent, exact version, distribution, and
installation identity are idempotent and reuse the existing operation or
completed record.

### Product and API boundary

The browser will show, before installation or update:

- Agent ID and exact version.
- Distribution and source.
- License and registry provenance.
- Checksum and integrity status.
- Installation risk and requested trust transition.

Launch commands, package-manager arguments, archive URLs, and local paths
remain daemon-owned details. They are exposed only through appropriately
scoped diagnostics, never as ordinary workflow or thread configuration.

---

## Consequences

### Positive

- Binary-only ACP agents can enter the same installed inventory as package
  agents.
- Installed artifacts become reproducible, auditable, and safer to recover.
- Updates are explicit and historical execution identity remains immutable.
- The ACP supervisor keeps one runtime boundary for every distribution type.
- Installation failures, integrity risks, and removal conflicts become
  actionable browser states.

### Negative / Risks

- Archive extraction and executable resolution are security-sensitive code
  requiring extensive platform and fixture testing.
- Supporting side-by-side versions increases storage and lifecycle complexity.
- Package-manager execution remains a supply-chain risk even when pinned.
- Binary formats and executable layouts vary across operating systems.
- Checksum availability depends on registry quality; checksumless artifacts
  require a deliberate product policy.

### Deferred

This ADR does not implement:

- Terminal authentication or environment-variable secret storage.
- Custom agents or private registries.
- Container, VM, or OS sandbox execution.
- Spend budgets or concurrent workflow policy.

Those capabilities must use the installed-agent and trust boundaries defined
here rather than creating separate installation or runtime paths.

---

## Alternatives considered

1. **Keep `npx` as the only supported distribution.** Rejected. It excludes
   binary-only and `uvx` agents and leaves the target registry model
   incomplete.

2. **Install binaries directly into their final location.** Rejected. A
   failed download, extraction, or verification could leave selectable
   partial state.

3. **Replace an installed version in place during updates.** Rejected. It
   breaks reproducibility and can rewrite the runtime identity behind
   historical or active records.

4. **Treat registry checksums as optional metadata with no product state.**
   Rejected. Integrity status is part of the user's trust decision and must be
   persisted and visible.

5. **Let the ACP supervisor install distributions on demand.** Rejected. It
   couples runtime startup to network and package state, bypasses durable
   installation operations, and violates the boundary established by
   ADR-0006 and ADR-0007.

---

## Implementation direction

Create a distribution adapter boundary under `src/installations/` with
separate validated implementations for binary archives, `npx`, and `uvx`.
Keep archive safety, checksum verification, atomic publication, version
identity, reference checks, and operation recovery in daemon-owned modules.
Extend installed-agent APIs and the browser Agents area for explicit update,
side-by-side version inspection, integrity status, and safe removal.

High-value tests include registry distribution fixtures, checksum mismatch,
unsafe archive paths and links, extraction limits, executable containment,
atomic publication, interrupted-operation recovery, duplicate installation,
side-by-side version history, active-reference removal conflicts, and launch
specification resolution without shell execution.
