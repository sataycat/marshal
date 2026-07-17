# ADR-0002a: Chat Session Model

**Status:** Accepted
**Date:** 2026-07-16
**Parent:** ADR-0002 (Chat Interface)

## Decision

Marshal owns a repository-scoped `chat_threads` record identified by a UUID. A
thread stores its agent identity, absolute repository root, working directory,
title, lifecycle state, archive/pin flags, timestamps, and optional task slug.
Creating a thread is zero-cost: it creates no ACP process or session and starts
in `draft`. The first persisted message moves it to `active`; callers may
explicitly move it to `closed` or `error`.

Messages are immutable `user` or `assistant` rows in `chat_messages`, ordered
by an integer ID. Marshal stores the message text as the durable transcript;
ACP session identity and resumption remain adapter concerns for a later slice.

Threads are visible only when their stored repository root matches the current
daemon repository. Archived threads are excluded from the default list but can
be requested explicitly. The daemon exposes `GET/POST /api/threads`,
`GET/PATCH /api/threads/:id`, and `GET/POST /api/threads/:id/messages`.
Successful mutations publish `thread.created`, `thread.updated`, and
`thread.message` on the existing WebSocket bus. The WebSocket connected
snapshot includes both tasks and repository threads.

## Consequences

- Browser deep links have a stable ID without coupling to ACP session IDs.
- A daemon restart retains thread metadata and transcript.
- Runtime session resumption, permissions, attachments, title generation, and
  message event streaming are intentionally deferred to later slices.
