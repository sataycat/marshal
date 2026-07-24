# ADR-0012 Slice 4: consolidated database ownership matrix

Fresh installations have one physical SQLite store at
`$MARSHAL_HOME/marshal.db`. The migration journal and every schema mutation
are packaged under `src/storage/migrations/`.

| Table family | Ownership | Required boundary |
| --- | --- | --- |
| `repositories` | machine | immutable repository ID |
| registry, installations, credentials, preferences | machine | no repository ID |
| workflow profiles and assignments | repository | non-null `repository_id`; assignment/profile composite ownership |
| tasks and spec messages | repository | repository-leading indexes; task composite ownership |
| runs, operations, events | repository | run/task composite ownership |
| threads, messages, attachments | repository | thread composite ownership |
| ACP sessions, prompts, events, permissions | repository | session/thread composite ownership |
| spec-author sessions and operations | repository | task/profile/session composite ownership |

Repository IDs are authorization and query boundaries. Checkout paths remain
execution metadata only. No database is opened from a checkout path, and no
Marshal database is created under a checkout.

## Reset-only legacy contract

The pre-1.0 cutover intentionally does not import `machine.db` or
`<repository>/.marshal/state.db`. If `$MARSHAL_HOME/machine.db` is present,
Marshal fails with `legacy_layout_reset_required`. Stop Marshal, preserve any
needed source/config files separately, remove or replace the old Marshal home,
and start with a fresh `MARSHAL_HOME`. Never delete a checkout as part of this
reset.
