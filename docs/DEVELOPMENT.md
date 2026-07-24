# Marshal development storage

Set `MARSHAL_HOME` to an isolated temporary directory when developing or
testing. This keeps databases, credentials, attachments, installations,
worktrees, logs, and daemon files out of source checkouts:

```sh
MARSHAL_HOME=/tmp/marshal-dev-home pnpm run test
```

Tests should assert that repository paths remain source-only. `marshal.json`
and `.worktreeinclude` are deliberately read from the checkout because they
are project inputs; they are not storage locations. Do not add setup helpers
that create `<repository>/.marshal`.

When investigating a database, stop the daemon before replacing the home.
SQLite live backups must use SQLite's backup mechanism rather than copying the
database file in isolation. A fresh home is the supported pre-1.0 migration
path; do not add legacy repository scanning or split-layout compatibility.
