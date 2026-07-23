# ADR-0012: Consolidated Daemon Storage

**Status:** Accepted
**Date:** 2026-07-23
**Related:** ARCHITECTURE.md, PROJECT.md
**Supersedes:** ADR-0011 sections 1, 3, 5, 7, and the corresponding implementation direction where they require separate machine and repository databases; archived ADR-0002b decision 2

---

## Context

Marshal is installed as one daemon on a developer machine, private server, or
VPS. Repositories are durable resources registered with that daemon. They are
not independent Marshal installations, and Marshal does not require repository
history to travel with a source checkout.

The current implementation splits durable state across:

- `~/.marshal/machine.db` and adjacent machine-owned files.
- `<repository>/.marshal/state.db` and repository-owned files.

This split makes application state follow two different ownership and lifecycle
models even though one daemon is authoritative for both. It complicates backup,
restore, reset, deployment volume configuration, diagnostics, migrations, and
cross-scope integrity. It also writes hidden application state into source
checkouts, which may be read-only, ephemeral, shared, deleted, moved, or
accidentally committed.

Repository scope remains important for authorization, queries, cleanup, and the
product model. It does not require a separate database or storage root.

---

## Decision

Marshal will store all daemon-owned durable state beneath one configurable data
directory and in one SQLite database.

### 1. One Marshal home

The storage root is `MARSHAL_HOME` when set and otherwise defaults to
`~/.marshal`.

All daemon-owned state lives beneath this directory, including the database,
registry cache, pinned installations, credential-file fallback, attachments,
artifacts, worktrees, logs, and daemon lifecycle metadata.

A representative layout is:

```text
<MARSHAL_HOME>/
  marshal.db
  registry/
  agents/
    <agent-id>/
      <version>/
        <installation-id>/
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

The exact internal file layout may evolve through migrations, but no durable
Marshal application state will be stored inside a registered source checkout.
Repository-owned project inputs such as `marshal.json` or `.worktreeinclude`
are source configuration, not daemon state, and may remain in the repository.

### 2. One SQLite database

Marshal will use one `marshal.db` for machine-scoped and repository-scoped
records. There is one schema and one ordered migration stream.

Repository-scoped records carry an immutable `repository_id` foreign key.
This includes threads, messages through thread ownership, workflow profiles,
tasks, sessions, permission requests, runs, events, artifacts, attachments,
and repository preferences.

Machine-scoped records include registry state, installed agents, installation
operations, agent readiness and authentication metadata, credential references,
and daemon preferences.

Scope remains explicit in schemas and store modules. Physical consolidation
does not permit repository-scoped APIs or queries to omit repository ownership.

### 3. Daemon-owned file namespaces

Files that do not belong in SQLite are stored beneath
`repositories/<repository-id>/` or another appropriate `MARSHAL_HOME`
namespace. Paths use daemon-generated stable identifiers, never repository
names or client-provided path components.

Attachment and artifact metadata remains in SQLite. File creation, validation,
quota enforcement, lookup, and deletion remain daemon-owned. Moving these bytes
out of the source checkout does not change their repository ownership or API
access controls.

Task worktrees are also daemon state and live beneath `MARSHAL_HOME`. They are
not stored in the source checkout and are not part of repository portability.

### 4. Secrets remain separately protected

One storage root does not mean secrets are stored in SQLite. Marshal should use
an OS credential store or explicit external secret source where available. A
file-backed fallback may live beneath `MARSHAL_HOME/credentials` with restrictive
permissions and opaque references persisted in `marshal.db`.

### 5. Backup, reset, and deployment boundary

`MARSHAL_HOME` is the complete Marshal persistence boundary for backup,
restore, persistent-volume mounting, diagnostics, and development reset.

A consistent backup must be taken through SQLite's supported backup mechanism
or while the daemon is stopped; copying a live SQLite file and its adjacent
directories independently is not guaranteed to produce a consistent snapshot.

Deleting `MARSHAL_HOME` while Marshal is stopped produces a fresh installation.
The product may later expose selective cleanup operations, but those operations
must not recreate a second persistence root.

### 6. Migration from split storage

Marshal is pre-1.0 and there is no requirement to preserve current development
data. The implementation may replace split machine and repository databases
with a documented full reset rather than a compatibility layer.

Before 1.0, any decision to preserve a known deployed dataset must be handled by
one bounded, tested import into `marshal.db`, not by indefinitely reading or
writing both layouts. The daemon must not silently import `.marshal` directories
found in arbitrary repositories.

---

## Consequences

### Positive

- One directory defines the backup, restore, reset, and deployment-volume
  boundary.
- Source checkouts remain free of hidden Marshal databases and artifacts.
- Repository removal, relocation, or loss does not implicitly delete Marshal
  history.
- One migration stream and one SQLite transaction boundary simplify upgrades
  and integrity checks.
- Foreign keys can enforce relationships between repositories, installed agent
  versions, assignments, sessions, and workflow history.
- The daemon can support cross-repository diagnostics and views without opening
  multiple databases.
- Read-only and ephemeral source checkouts remain usable as registered
  repositories where the requested operation otherwise permits it.

### Negative and risks

- `marshal.db` is a larger failure and contention domain than separate files.
- Backup and restore are all-or-nothing by default rather than naturally split
  by repository.
- Repository deletion requires explicit retention or cleanup semantics for its
  database records and file namespace.
- Filesystem and database changes cannot be one atomic transaction, so stores
  need bounded write ordering and garbage-collection recovery.
- Existing split development state is discarded unless a specific import is
  later justified and implemented.

These risks are acceptable for a single-daemon local-first product. SQLite WAL,
short transactions, foreign keys, integrity checks, bounded file operations,
and explicit backup guidance remain required.

---

## Alternatives considered

1. **Keep one machine database and one database inside each repository.**
   Rejected. Repository history is not intended to be portable, and the layout
   complicates operations while coupling durable product history to checkout
   availability and permissions.

2. **Keep separate databases but place all of them under `MARSHAL_HOME`.**
   Better than repository-local storage, but rejected. It retains multiple
   migration streams, cross-database integrity gaps, selected-repository open
   behavior, and more complex backup coordination without a required lifecycle
   distinction.

3. **Use one database per repository under `MARSHAL_HOME`.** Rejected. It makes
   repository export easier, but export and portable history are not product
   requirements. It also prevents ordinary foreign keys to machine-wide agent
   inventory and complicates cross-repository operations.

4. **Use a server database.** Rejected. Marshal targets a single local daemon
   and does not need the operational burden of a database service. SQLite
   remains the appropriate durable store.

5. **Store all bytes in SQLite.** Rejected. Large attachments, artifacts,
   installations, logs, and worktrees are better represented as bounded files
   with database metadata and daemon-owned paths.

---

## Implementation direction

1. Add a single storage-root resolver for `MARSHAL_HOME`, defaulting to
   `~/.marshal`, and remove direct home-directory and repository `.marshal`
   path construction from feature modules.
2. Define one Drizzle schema and one migration stream for `marshal.db`.
3. Add required `repository_id` columns, foreign keys, and indexes to every
   repository-scoped resource.
4. Update stores to require repository identity explicitly instead of deriving
   persistence from the selected repository path.
5. Move attachments, artifacts, and worktrees to stable repository-ID
   namespaces beneath `MARSHAL_HOME/repositories`.
6. Remove repository-state initialization and all writes to
   `<repository>/.marshal`.
7. Update diagnostics and documentation to expose the resolved storage root,
   database path, backup boundary, and reset behavior.
8. Replace the current development layout with a documented reset unless a
   concrete deployed dataset requires a bounded import.
9. Test empty initialization, migration compatibility, foreign-key integrity,
   repository deletion semantics, filesystem cleanup recovery, custom
   `MARSHAL_HOME`, and fresh-install reset behavior.

ADR-0011 continues to govern Drizzle, checked-in ordered migrations,
forward-only compatibility, parameterized SQL, and migration testing except
where it requires separate databases, schemas, migration streams, or adoption
of repository-local state.
