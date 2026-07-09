# ADR-015: Board Interactions for Task Creation and Transitions

## Status

Accepted — 2026-07-09

Implements `docs/M1-VERTICAL-SLICES.md` Slice 6 (Board Interactions).

## Context

Slice 5 makes the board observable. Slice 6 makes it driveable: users can create tasks, freeze specs, and trigger valid state transitions from the browser.

The risk is creating a second lifecycle implementation in the UI. The server-side state machine from ADR-011 and ADR-009 must remain authoritative.

## Decisions

### 1. The board is a thin client over the task HTTP API

The UI uses the existing Slice 2 endpoints:

| User action                         | Endpoint                           |
| ----------------------------------- | ---------------------------------- |
| Create task                         | `POST /api/tasks`                  |
| Freeze spec / move Backlog to Ready | `POST /api/tasks/:slug/ready`      |
| Manual transition                   | `POST /api/tasks/:slug/transition` |

The browser never shells out to `marshal` and never mutates SQLite directly.

### 2. Show known valid actions, but let the server enforce truth

The M1 board may hardcode the current state-to-action map for display:

| Status       | Primary UI actions                             |
| ------------ | ---------------------------------------------- |
| `backlog`    | Freeze to Ready                                |
| `ready`      | No manual action in Slice 6; daemon claims it. |
| `building`   | Re-queue to Ready, Send Back to Backlog        |
| `validating` | Send Back to Backlog                           |
| `review`     | Mark Done                                      |
| `done`       | None                                           |

The UI only hides unavailable buttons for clarity. It is not an authority. Every transition still goes through `transitionTask` on the server, which returns `409` for invalid edges.

### 3. Use optimistic updates with explicit rollback

For create and transition actions, the board may optimistically update local state so the UI feels immediate. Each optimistic mutation keeps the previous task/card state until the HTTP response returns.

On success:

- replace the optimistic state with the server-returned task
- accept any subsequent WebSocket event as a normal refresh

On failure:

- restore the previous local state
- show a toast with the server error envelope
- do not invent a success-shaped WebSocket event

If a WebSocket event arrives while a mutation is in flight, the response from the server remains the final authority for that action; a follow-up `GET /api/tasks/:slug` can reconcile if needed.

### 4. Escape-hatch transitions require confirmation

The UI must confirm transitions that reset retry state or send work back:

- `building → ready`
- `building → backlog`
- `validating → backlog`

The confirmation text should make the side effect explicit: the retry state is reset, and sending back to Backlog means the spec likely needs revision.

This mirrors ADR-009's distinction between automated transitions and manual recovery.

### 5. Task creation starts in Backlog with editable spec markdown

The New Task modal collects:

- `title` (required)
- `spec_markdown` (optional draft)

The created task starts in `backlog`. The server generates the slug. The UI does not precompute or reserve slugs.

### 6. Freeze is a distinct action from a generic transition

Backlog-to-Ready uses `POST /api/tasks/:slug/ready`, not generic `transition`.

That endpoint owns spec replacement, spec freeze, git commit, and worktree creation. If any freeze side effect fails, the UI must display the error and not pretend the task is Ready.

## Consequences

- The board can drive the M1 lifecycle while preserving the server-side state machine as the only source of truth.
- Optimistic UI improves responsiveness without hiding server failures.
- Escape hatches stay visibly human-driven and harder to click accidentally.
- The UI can ship before a server-provided transition-discovery endpoint exists.

## Open questions (deferred)

- **Transition discovery endpoint.** If states/actions become configurable, add an endpoint that returns allowed actions per task instead of hardcoding the M1 map in the UI.
- **Concurrent tabs.** M1 relies on WebSocket updates and server authority. If conflicting edits become common, add version checks to mutations.
- **Spec editor richness.** M1 uses a textarea. A richer markdown editor can be introduced after the lifecycle is stable.

## Related

- `docs/M1-VERTICAL-SLICES.md` Slice 6 — Board Interactions.
- `docs/adr/ADR-011-task-crud-api.md` — task mutation endpoints.
- `docs/adr/ADR-009-escape-hatch-transitions.md` — manual recovery semantics.
- `docs/adr/ADR-014-frontend-build-and-serve.md` — SPA client strategy.
