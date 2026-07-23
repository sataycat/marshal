# ADR-0011: Drizzle Schema and Migrations

**Status:** Accepted  
**Date:** 2026-07-23  
**Related:** ARCHITECTURE.md, PROJECT.md

---

## Context

Marshal stores durable local state in SQLite. It currently has two database
scopes:

- A machine database for repositories, preferences, registry state,
  installations, and credential references.
- A repository database for threads, messages, ACP sessions, permissions,
  tasks, runs, and workflow evidence.

The current repository database initialization executes the latest
`schema.sql`, inspects selected tables with `PRAGMA table_info`, and applies
missing columns with conditional `ALTER TABLE` statements. Machine-level
modules create their own tables lazily with `CREATE TABLE IF NOT EXISTS`.

This was sufficient while the schema was small and disposable, but it is not a
release-grade migration model. It does not provide an ordered history of
changes, a reliable record of which changes ran, explicit compatibility checks,
or a consistent place for data backfills. It also makes partial upgrades and
schema ownership difficult to reason about as durable sessions and workflow
state become more valuable.

Raw SQL is not inherently unsafe. Marshal's application queries generally bind
values through SQLite parameters, which is the relevant SQL-injection control.
The problems are instead:

- Schema and TypeScript types can drift independently.
- Schema changes are side effects of opening individual stores.
- Upgrade behavior is spread across initialization code and feature modules.
- Introspection cannot distinguish a valid migration history from a database
  that happens to contain similarly named columns.
- Non-trivial SQLite changes require ordered table rebuilds and data
  transformations, not independent column-existence checks.
- An older Marshal binary does not explicitly reject a database written by a
  newer, incompatible release.

Marshal needs deterministic release upgrades without introducing a remote
database service, a large persistence abstraction, or rollback machinery that
the product does not currently require.

---

## Decision

Marshal will use Drizzle ORM with the existing `better-sqlite3` driver as the
authoritative SQLite schema and migration layer.

Drizzle will provide:

- TypeScript schema definitions for tables, columns, indexes, and relations.
- Checked-in, ordered SQL migrations.
- A durable migration journal recording applied migrations.
- Typed query construction for new and substantially changed store code.

`better-sqlite3` remains the database driver. Marshal will not introduce a
database server or replace SQLite.

### 1. Separate migration streams

Machine and repository databases have different lifecycles and will use
separate schemas and migration directories:

```text
src/storage/
  machine-schema.ts
  repository-schema.ts
  migrations/
    machine/
    repository/
```

Each database records only migrations from its own stream. A machine migration
must not depend on a selected repository, and a repository migration must not
modify machine state.

### 2. Migrations are the only schema mutation path

After adoption, application startup and feature stores will not create,
alter, or drop application tables directly.

- `CREATE TABLE`, `ALTER TABLE`, table rebuilds, index changes, and schema data
  backfills belong in checked-in migrations.
- Store modules may not lazily create tables.
- `PRAGMA table_info` and related introspection may be used by migration
  adoption, diagnostics, integrity checks, and tests, but not as the normal
  mechanism for deciding which schema changes to apply.
- Historical migrations are immutable after they have shipped in a release.
  Corrections are new migrations.

The Drizzle TypeScript schema represents the current application schema. The
ordered migrations represent how persisted databases reach that schema. A
separate hand-maintained latest-schema SQL file will not remain as a competing
source of truth.

### 3. Migrations run before stores access data

The daemon will migrate both scopes at controlled database-open boundaries:

1. Open the SQLite database and configure required connection pragmas.
2. Acquire the local migration lock provided by SQLite's transaction model.
3. Validate migration compatibility.
4. Apply pending migrations in order.
5. Open application stores only after migration succeeds.

Migration failure prevents the affected database from being used. Marshal will
surface a stable diagnostic rather than continuing against a partially known
schema.

Migrations will run transactionally where SQLite permits. A migration that
cannot be safely expressed as one transaction must explicitly implement and
test its recovery behavior before release.

### 4. Compatibility is forward-only

Marshal supports upgrading an older database to the schema included with the
running binary.

- A database with pending known migrations is upgraded automatically at daemon
  startup.
- A database whose migration journal contains unknown newer migrations is
  rejected with a clear "database created by a newer Marshal version" error.
- Application startup never silently deletes or recreates an incompatible
  database.
- Binary downgrades and reverse migrations are not supported.
- Release notes will call out migrations that are destructive, long-running,
  or change the oldest supported upgrade path.

Before 1.0, Marshal may intentionally stop supporting very early development
schemas. Such a decision must be explicit and must provide either a tested
one-time migration or a clear development-data reset instruction. Starting
with 1.0, every supported release upgrade path must preserve durable user data.

### 5. Adopt existing pre-migration databases once

The first migration-enabled release will include an explicit adoption path for
the current machine and repository schemas.

The adoption code may inspect known legacy schema shapes to determine whether
the database is:

- Empty and should receive the full migration sequence.
- A recognized current pre-migration database that can be baselined and then
  upgraded.
- An unsupported or inconsistent database that must fail with a diagnostic.

This introspection is a bounded transition, not a permanent parallel migration
system. Once a database has a Drizzle migration journal, normal migration
ordering is authoritative.

### 6. Typed queries are the default, not an absolute rule

New stores and materially changed queries should use Drizzle's typed query API.
Existing parameterized `better-sqlite3` queries may migrate incrementally.

Raw SQL remains acceptable when it is clearer or necessary for:

- SQLite-specific features and pragmas.
- Complex reporting or orchestration queries.
- Migration SQL.
- Performance-sensitive statements where generated SQL has been inspected.

All dynamic values in raw application SQL must be bound parameters. Dynamic
identifiers or SQL fragments derived from request, registry, agent, repository,
or persisted user input are prohibited unless validated against a closed,
code-owned allowlist.

Adopting Drizzle does not by itself provide the SQL-injection boundary;
parameter binding and controlled identifiers remain mandatory.

### 7. Upgrade behavior is tested as product behavior

Migration tests will cover both database scopes and include:

- Empty database to current schema.
- Recognized pre-migration database to current schema.
- Representative released schema versions to current schema after 1.0.
- Preservation and transformation of durable data, not only table shape.
- Rejection of an unknown newer migration journal.
- Failure behavior for inconsistent or interrupted migration state.
- `PRAGMA integrity_check` and `PRAGMA foreign_key_check` after fixture
  upgrades.

Any migration that rebuilds a table, changes constraints, or transforms stored
JSON must include a focused upgrade fixture proving preservation of relevant
records.

---

## Consequences

### Positive

- Release upgrades become ordered, repeatable, and auditable.
- Current schema definitions and TypeScript query types share one source.
- Machine and repository database ownership become explicit.
- Newer databases are not accidentally opened by incompatible older binaries.
- Data backfills and SQLite table rebuilds have a tested, durable home.
- Parameterized raw SQL remains available where it is the simplest correct
  tool.

### Negative / Risks

- Drizzle and its migration tooling add dependencies and generated artifacts.
- The initial adoption migration must accurately recognize existing database
  shapes.
- Two migration streams require discipline in generation, packaging, and
  testing.
- Drizzle's types do not validate JSON payload contents or replace domain-level
  decoding and validation.
- SQLite migration limitations still require careful table rebuilds for some
  schema changes.

### Deferred

This ADR does not introduce:

- A remote database or support for multiple database engines.
- Runtime schema synchronization from TypeScript without checked-in migrations.
- Automatic down migrations or support for binary downgrades.
- A general repository/unit-of-work abstraction over every store.
- A requirement to rewrite every existing SQL query before migrations can ship.
- Online zero-downtime migrations; the local daemon may briefly block startup
  while applying bounded migrations.

---

## Alternatives considered

1. **Continue `PRAGMA table_info` reconciliation.** Rejected. It has no durable
   migration order, cannot represent schema history reliably, and becomes
   fragile for table rebuilds and data transformations.

2. **Add a custom SQL migration runner without Drizzle.** Viable but rejected.
   It would solve ordering while leaving schema and query types manually
   synchronized. Drizzle provides both with a small SQLite-compatible runtime.

3. **Use Kysely with a custom migration provider.** Viable, but not selected.
   Kysely is a strong typed query builder; Drizzle more directly combines
   SQLite schema declarations, generated migrations, and `better-sqlite3`
   integration for Marshal's needs.

4. **Use Prisma.** Rejected. Its generated client and engine model add more
   weight and operational machinery than this local SQLite daemon requires.

5. **Replace all raw SQL immediately.** Rejected. It creates a broad rewrite
   without improving the most urgent release risk. Migration correctness comes
   first; typed query adoption can proceed store by store.

6. **Support automatic down migrations.** Rejected. Reverse data
   transformations are often lossy and would substantially increase testing
   and release complexity. Marshal will fail clearly on binary downgrade.

---

## Implementation direction

1. Add Drizzle runtime and development migration tooling configured for
   `better-sqlite3`.
2. Define machine and repository schemas from the current effective database
   shapes.
3. Generate and check in separate baseline migration streams.
4. Implement and test one-time adoption of recognized existing databases.
5. Replace schema creation and `PRAGMA table_info` reconciliation in
   `openMachineDb` and `openDb` with centralized migration runners.
6. Package migration files with the daemon build and verify installed-package
   startup, not only source-tree execution.
7. Add upgrade fixtures, compatibility errors, integrity checks, and migration
   failure tests.
8. Convert store queries incrementally, using Drizzle by default for new or
   materially changed persistence code.

The migration runner and schemas should remain small infrastructure modules.
Feature stores continue to own domain mapping and validation; this ADR does not
turn persistence into a separate framework layer.
