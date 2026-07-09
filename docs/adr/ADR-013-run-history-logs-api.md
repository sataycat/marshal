# ADR-013: Run History and Logs HTTP API

## Status

Accepted — 2026-07-09

Implements `docs/M1-VERTICAL-SLICES.md` Slice 4 (Run History & Logs API).

## Context

M0 already records builder and validator attempts in SQLite through `RunLog`. M1's web board needs that history over HTTP so a human can inspect streamed agent output, failure context, commit SHAs, and retry attempts without querying SQLite or using a CLI-only view.

Slice 3's WebSocket bus broadcasts live `run.*` events, but WebSocket delivery is intentionally not replayable. The durable run log remains the source of truth for history and reconnect recovery.

## Decisions

### 1. Expose run history as read-only JSON endpoints

The daemon will expose:

| Method | Path                    | Purpose                              |
| ------ | ----------------------- | ------------------------------------ |
| `GET`  | `/api/tasks/:slug/runs` | List all runs for one task.          |
| `GET`  | `/api/runs/:id`         | Return one run with task context.    |
| `GET`  | `/api/runs/:id/events`  | Return paginated events for one run. |

These endpoints are read-only. Runs are still created and finished only by the orchestrator and `RunLog`.

### 2. Keep HTTP response fields aligned with the existing REST API

HTTP responses use the same JSON style as ADR-011: database-derived fields are snake_case and wrapped in top-level envelopes.

`GET /api/tasks/:slug/runs` returns:

```json
{
  "runs": [
    {
      "id": 1,
      "task_id": 1,
      "role": "builder",
      "agent_id": "opencode",
      "status": "done",
      "started_at": "2026-07-09T00:00:00.000Z",
      "ended_at": "2026-07-09T00:01:00.000Z",
      "commit_sha": "abc123",
      "error": null
    }
  ]
}
```

`GET /api/runs/:id` returns `{ "run": { ... } }` with the same fields plus `prompt`.

`GET /api/runs/:id/events` returns:

```json
{
  "events": [
    {
      "seq": 1,
      "type": "stdout",
      "payload": {},
      "created_at": "2026-07-09T00:00:01.000Z"
    }
  ],
  "next_after_seq": 1
}
```

`next_after_seq` is the highest sequence number returned, or `null` when no events are returned.

### 3. Paginate run events by `seq`

`GET /api/runs/:id/events` accepts:

| Query parameter | Meaning                                                     |
| --------------- | ----------------------------------------------------------- |
| `after_seq`     | Return events with `seq > after_seq`. Omitted → from the start of the run (since `seq` begins at `0`). |
| `limit`         | Maximum events to return. Defaults to `100`; maximum `500`. |

The `seq` column is the pagination cursor because it is already monotonic within a run and indexed by `idx_run_events_run_id`.

Invalid query values return the ADR-011 error envelope with `400` for malformed numbers and `422` for out-of-range limits.

### 4. Reuse `RunLog`; do not add a second run store

Slice 4 should extend `RunLog` with query helpers as needed, such as:

- `listRunsForTask(taskId)`
- `getRun(runId)`
- `getEvents(runId, { afterSeq, limit })`

HTTP handlers must call those helpers rather than duplicating SQL in the route layer. The route layer owns request parsing and response mapping; `RunLog` owns run persistence and retrieval.

### 5. Broadcast live events only after durable writes

`RunLog.insertEvent` already writes to SQLite before publishing `run.event` through the bus. Slice 4 preserves that ordering. A browser that receives a live WebSocket event can immediately fetch `/api/runs/:id/events?after_seq=...` and observe the persisted event.

The WebSocket payload stays lightweight (`{ runId, event }`). Full history, pagination, and reconnect recovery happen through HTTP.

### 6. Missing task or run IDs return `404`

Run endpoints must not leak ambiguous empty responses for unknown resources:

- Unknown task slug for `/api/tasks/:slug/runs` returns `404` with `code: "task_not_found"`.
- Unknown run ID for `/api/runs/:id` or `/api/runs/:id/events` returns `404` with `code: "run_not_found"`.

## Consequences

- The board can show historical and live run output using the same durable source.
- WebSocket reconnect remains simple: reconnect for current state, then use HTTP pagination for durable run events.
- Run event volume is bounded per request, preventing a single large run from forcing a huge HTTP response.
- The external API stays consistent with the task CRUD API's envelopes and field casing.

## Open questions (deferred)

- **Event payload versioning.** Agent event payloads are stored verbatim. If multiple agent adapters produce incompatible payloads, add a versioned normalized event layer.
- **Large-output retention.** M1 keeps all run events. Log compaction or retention limits can be added after real output sizes are known.
- **Backpressure for live output.** If WebSocket clients cannot keep up with run events, add batching or per-client queues without changing the durable HTTP API.

## Related

- `docs/M1-VERTICAL-SLICES.md` Slice 4 — Run History & Logs API.
- `docs/adr/ADR-006-builder-run-and-run-log.md` — run persistence source.
- `docs/adr/ADR-012-websocket-event-bus.md` — live `run.*` event delivery.
- `src/daemon/run-log.ts` — durable run log.
- `src/db/schema.sql` — `runs` and `run_events`.
