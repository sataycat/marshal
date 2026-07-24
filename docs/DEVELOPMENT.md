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

The consolidated-storage lifecycle acceptance tests use fake ACP agents and
safe in-process/file-backed credential doubles to prove installation,
readiness, credentials, chat, attachments, tasks, worktrees, and recovery
without executing a real third-party authenticated-agent browser/OAuth flow.
That external provider flow is an intentional verification boundary: it must
be tested manually with an approved account and is not claimed by the
automated suite.

When investigating a database, stop the daemon before replacing the home.
SQLite live backups must use SQLite's backup mechanism rather than copying the
database file in isolation. A fresh home is the supported pre-1.0 migration
path; do not add legacy repository scanning or split-layout compatibility.
