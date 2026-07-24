# Marshal operations

## Persistence boundary

The daemon owns one persistence root: `MARSHAL_HOME`, defaulting to
`~/.marshal`. The root contains `marshal.db`, the migration journal, registry
cache, installations, credential fallback, repository namespaces, logs, and
daemon lifecycle files. A registered checkout contains source code and project
inputs such as `marshal.json` and `.worktreeinclude`; Marshal does not create a
`.marshal` directory there.

Mount the complete root as a persistent volume in a container or VPS. Do not
mount only `marshal.db`: attachments, worktrees, installations, credentials,
and recovery metadata are part of the same operational boundary.

## Backup and restore

Stop the daemon for the simplest consistent backup:

```sh
marshal stop
tar -C "${MARSHAL_HOME:-$HOME}" -czf marshal-backup.tgz .marshal
```

Alternatively, use SQLite's online backup API while the daemon is running.
Do not copy `marshal.db`, `marshal.db-wal`, and `marshal.db-shm` as unrelated
files; a live file copy can be inconsistent. Restore the whole root while the
daemon is stopped and check the browser Diagnostics page after startup.

## Reset and legacy split layouts

For a stopped-daemon development reset, remove or replace the complete
`MARSHAL_HOME`, then start Marshal again. Never remove a source checkout as
part of a reset.

The pre-1.0 split layout is intentionally reset-only. Marshal does not import,
dual-read, or scan `machine.db`, repository `.marshal/state.db`, or arbitrary
repository `.marshal` directories. If Diagnostics reports
`LEGACY_LAYOUT_RESET_REQUIRED`, preserve needed source configuration and
secrets separately, replace the old Marshal home, and reconnect repositories.

## Read-only and ephemeral checkouts

Repository registration and non-mutating repository flows can use a read-only
or ephemeral checkout. Daemon state, attachments, and worktrees are stored in
the daemon root. Operations that modify source, create worktrees, run setup,
or merge still require an available writable checkout and report the reason in
Diagnostics or the API response.
