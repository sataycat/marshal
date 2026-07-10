# ADR-018: Spec Authoring Chat

## Status

Accepted — 2026-07-09

Implements `docs/M1-VERTICAL-SLICES.md` Slice 9 (Spec Authoring Chat).

## Context

Marshal's front human judgment point is spec authoring. The human owns the final acceptance criteria, but an agent can help ask clarifying questions, find gaps, and draft a tighter spec before the task is frozen.

The working spec remains mutable in SQLite until Ready. The frozen spec is committed only when the task is marked Ready.

## Decisions

### 1. Store chat history durably in SQLite

Add a `spec_messages` table:

```sql
CREATE TABLE IF NOT EXISTS spec_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE INDEX IF NOT EXISTS idx_spec_messages_task_id
  ON spec_messages(task_id, created_at, id);
```

`role` is limited to `user` and `assistant` for M1. System prompts are generated, not stored as chat messages.

### 2. Add narrow HTTP endpoints for chat and spec updates

The daemon will expose:

| Method | Path                             | Purpose                                                                              |
| ------ | -------------------------------- | ------------------------------------------------------------------------------------ |
| `GET`  | `/api/tasks/:slug/spec-messages` | List chat messages for a Backlog task.                                               |
| `POST` | `/api/tasks/:slug/spec-messages` | Store a user message, invoke the spec authoring agent, store the assistant response. |
| `POST` | `/api/tasks/:slug/spec`          | Replace `tasks.spec_markdown` with a selected draft.                                 |

`POST /api/tasks/:slug/spec-messages` returns both persisted messages:

```json
{
  "userMessage": {},
  "assistantMessage": {}
}
```

The endpoint may be synchronous in M1. If agent latency becomes a UX problem, later slices can split it into asynchronous send/respond events without changing the stored message model.

### 3. Broadcast chat updates over WebSocket

Each persisted message publishes:

```json
{
  "type": "spec.message",
  "payload": {
    "taskSlug": "example-task",
    "message": {}
  },
  "timestamp": "2026-07-09T00:00:00.000Z"
}
```

This keeps multiple tabs in sync. HTTP remains the durable source for page load and reconnect recovery.

### 4. Configure the spec authoring agent separately

Global config gains:

```json
{
  "agents": {
    "specAuthor": "opencode"
  }
}
```

If omitted, the spec authoring agent defaults to the builder agent. This keeps M1 usable with one configured agent while leaving room to separate authoring from implementation later.

### 5. Use a prompt template that preserves human ownership

The generated system prompt tells the agent:

- ask questions when requirements are ambiguous
- identify missing acceptance criteria and edge cases
- propose a concise vertical-slice spec
- avoid expanding the task beyond one mergeable diff
- do not mark the spec final; the human decides when to update and freeze

The prompt includes:

1. current task title and status
2. current `tasks.spec_markdown`
3. recent chat history
4. instruction to include a proposed replacement spec only in a fenced `marshal-spec` block

Example response contract:

````markdown
Here are the gaps I see...

```marshal-spec
# Goal
...
```
````

### 6. Use bounded recent context for M1

All chat messages are stored, but each agent turn sends only:

- the current spec draft
- the task title
- the latest chat messages up to a configurable character budget

Default budget: 24,000 characters of chat history, counted from newest to oldest.

M1 does not add summarization because summaries can silently distort requirements. If a chat exceeds the budget, older turns are omitted from the prompt but remain visible in the UI. The agent is told that older history may be omitted and should ask if context appears missing.

### 7. "Update Spec" applies only explicit proposed specs

The UI enables Update Spec only when the latest assistant message contains a fenced `marshal-spec` block. Clicking Update Spec sends that block content to `POST /api/tasks/:slug/spec`.

This avoids fragile free-form extraction from an ordinary assistant reply. The human still chooses whether to apply the draft.

Freeze remains `POST /api/tasks/:slug/ready` from ADR-011.

## Consequences

- Spec authoring becomes collaborative without moving source-of-truth spec state out of SQLite.
- The human remains the approval point for updating and freezing the spec.
- Prompt context is bounded and deterministic for M1, with no lossy summaries.
- The `marshal-spec` block gives the UI a reliable way to apply proposed specs.

## Open questions (deferred)

- **Long-chat summarization.** Add explicit, reviewable summaries only after the simple recent-context budget proves insufficient.
- **Streaming responses.** M1 can wait for a full assistant response. Streaming can be added through `spec.message.delta` events later.
- **Multi-agent authoring.** M1 uses one configured spec author. Comparing drafts from multiple agents is deferred.

## Related

- `docs/M1-VERTICAL-SLICES.md` Slice 9 — Spec Authoring Chat.
- `docs/PROJECT.md` §3.4 and §7 — mutable working spec in SQLite, frozen spec at Ready.
- `docs/adr/ADR-005-spec-freeze-at-ready.md` — freeze semantics.
- `docs/adr/ADR-011-task-crud-api.md` — Ready endpoint.
- `docs/adr/ADR-015-board-interactions.md` — browser interaction model.
