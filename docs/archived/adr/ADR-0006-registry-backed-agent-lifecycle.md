# ADR-0006: Registry-Backed Agent Lifecycle

**Status:** Accepted  
**Date:** 2026-07-18  
**Parent:** ADR-0005  
**Supersedes:** The agent-command configuration decision in archived ADR-0003

---

## Context

The direct ACP SDK runtime established that Marshal should communicate with agents through ACP and spawn processes without a shell. It also concluded that ACP did not define a universal registry, so each builder, validator, and spec-author role stored a complete executable command.

The ACP Registry now provides a curated catalog with stable agent IDs, versions, metadata, authentication support, and binary, `npx`, or `uvx` distributions. Keeping executable commands attached to workflow roles would discard most of that model:

- One agent used by several roles would be configured several times.
- Threads and workflows would not share a coherent installed-agent inventory.
- Registry updates could silently change package resolution if commands remain unpinned.
- The product could not distinguish discovery, installation, authentication, readiness, assignment, and execution.
- Binary integrity, archive safety, provenance, and updates would remain outside Marshal.

Registry entries are remote supply-chain input. Registry curation establishes interoperability and authentication support, not trust or sandboxing. Marshal must materialize a validated entry into a pinned local installation before it becomes executable product state.

---

## Decision

The ACP Registry is Marshal's default agent catalog. Marshal owns a separate installed-agent inventory that resolves registry or custom agent definitions into local launch specifications.

The core lifecycle is:

```text
available -> installing -> installed -> authenticating -> ready
```

Installation, authentication, readiness, assignment, and unattended execution are separate state transitions and require separate policy or user decisions.

### Registry source

The default public source is:

```text
https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
```

Marshal validates registry documents at the daemon boundary, rejects unsupported major schema versions, limits network responses, and caches the last valid snapshot. The registry snapshot is discovery metadata, not a launch-time dependency.

Marshal may later support private registries. Custom local agents are supported from the start or as an early follow-up, but enter the same installed-agent model as public entries.

### Installed identity

An installed agent is identified by at least:

- Stable agent ID.
- Exact version.
- Source and registry snapshot provenance.
- Distribution type and package/archive provenance.
- Resolved local launch specification.
- Installation and integrity status.

Threads, sessions, workflow assignments, and runs reference the installed agent identity. They do not persist registry URLs or executable arguments as their product configuration.

Historical execution records persist the resolved agent ID and version. Installing or selecting a newer version never rewrites existing thread or run history.

### Distribution selection

Marshal supports registry-declared:

- Platform-specific binary distributions.
- Version-pinned `npx` distributions.
- Version-pinned `uvx` distributions.

The default preference is:

1. A compatible binary with a verifiable checksum.
2. A version-pinned `npx` package.
3. A version-pinned `uvx` package.

The user may select among supported distributions, but Marshal never converts a pinned registry version into a moving `latest` alias.

Binary installation must download to temporary storage, verify SHA-256 when declared, reject unsafe archive entries, enforce extraction limits, ensure the command resolves inside the installation root, and publish the completed version atomically.

Missing checksums remain visible installation risk. Marshal may require explicit confirmation or reject checksumless binaries according to product policy; it must not represent them as verified.

Registry-provided arguments and environment values are untrusted executable configuration. Marshal passes structured arguments directly without shell interpolation and validates or requires confirmation for dangerous environment overrides.

### Authentication and readiness

Installation does not imply usability. Marshal initializes the installed agent through ACP, records its advertised authentication methods and capabilities, and drives supported authentication from the web application.

Supported authentication classes are:

- Agent-managed authentication.
- Terminal authentication through a daemon PTY.
- Environment-variable authentication with secret references outside ordinary project and installation metadata.

An agent becomes ready only after a bounded ACP initialization and probe session succeeds with authentication satisfied. Readiness records actionable failures and negotiated capabilities.

### Assignments

Threads and workflow profiles select installed agent IDs. Builder, validator, and spec-author are assignments, not executable definitions. An assignment may add negotiated ACP configuration such as a model or mode but does not duplicate installation details.

Installing an agent never automatically assigns it to a workflow. Assigning an agent never automatically authorizes unattended execution.

---

## Consequences

### Positive

- Conformant registry agents can be added without Marshal-specific adapters or command documentation.
- Installed versions are reproducible and auditable.
- Chat and factory workflows share one agent inventory.
- Agent updates become explicit and do not alter historical execution records.
- Installation, authentication, and readiness failures can be represented precisely.
- Custom and private agents can use the same lifecycle rather than creating another runtime path.

### Negative / Risks

- Marshal becomes responsible for downloads, package execution, checksum verification, archive extraction, and installation cleanup.
- The registry schema and ACP authentication methods will evolve and require compatibility work.
- Binary distribution support is platform-sensitive, especially on Windows.
- Terminal authentication adds PTY lifecycle and browser terminal security concerns.
- Package-manager distributions can execute install hooks and remain supply-chain risks even when version-pinned.
- Supporting multiple installed versions requires storage and update policy.

### Security

Installing an agent is remote code execution by consent. The user must see source, version, distribution, license, integrity status, and requested trust transition before installation or unattended assignment.

Registry curation and ACP permissions do not sandbox the installed process. Strong isolation remains an explicit execution policy owned by workflow or workspace configuration.

---

## Alternatives considered

1. **Generate direct role commands from registry entries and keep the current config model.** Rejected. It treats registry integration as code generation, duplicates installations across roles, and prevents a coherent machine-wide agent inventory.

2. **Execute the latest registry entry directly without local installation records.** Rejected. It makes executions non-reproducible and couples availability to a mutable remote snapshot.

3. **Support only `npx` initially and ignore binary and `uvx` entries.** Rejected as the target architecture because important agents are binary-only. Delivery may be incremental, but the model must cover all registry distribution types.

4. **Trust registry curation as sufficient security validation.** Rejected. The registry verifies interoperability and authentication support, not code safety or confinement.

5. **Disallow custom agents.** Rejected. The public registry is curated rather than exhaustive, and local development and private agents are legitimate ACP use cases.

---

## Implementation direction

Registry parsing, distribution selection, installation, authentication, readiness, and assignment remain separate modules and persistence concerns. The ACP runtime receives only a resolved local launch specification; it does not fetch registry metadata or install packages while spawning a session.
