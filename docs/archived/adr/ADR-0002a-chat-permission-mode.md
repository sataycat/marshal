# ADR-0002a: Chat Permission Mode

**Status:** Accepted
**Date:** 2026-07-16  
**Parent:** ADR-0002 (Chat Interface — Lightweight Web Client over ACP)

## Context

ACP agents can pause a prompt by sending `session/request_permission`. Marshal's
headless builder, validator, and spec-authoring flows already use explicit
non-interactive policies. Browser chat threads need a different policy: the
daemon must pause the active turn, show the exact ACP choices to the browser,
and resume only after an explicit human decision.

Permission handling is security-sensitive because ACP does not sandbox the
agent. The daemon must remain the authority, must not infer that an option is
safe from its position in the list, and must not turn a lost browser connection
into an approval.

## Decisions

1. **Policy is per thread and explicit.** Chat threads use `interactive` mode
   by default. Existing task/build/validate and spec-authoring flows retain
   their current explicit `approve-all`, `approve-reads`, or `deny-all` modes.
   Interactive mode is not used as a global adapter default.
2. **ACP option kinds are authoritative.** An approval selects an offered
   `allow_once` option. A denial selects an offered `reject_once` option. The
   daemon never selects the first option, trusts a label, or upgrades a
   one-time action to `*_always`. If the required kind is absent, the decision
   is rejected and the ACP request is cancelled.
3. **The daemon owns pending decisions.** A pending request is held in memory
   by the active chat turn and identified by a daemon-generated opaque request
   ID. The WebSocket event contains the request details and ACP options. A
   `GET` pending-permissions endpoint lets a reconnecting browser recover the
   current request; no permission is persisted as durable chat history.
4. **Decisions are single-use and scoped.** A decision must name the thread,
   request ID, and an option action (`approve` or `deny`). Unknown, stale,
   already-resolved, or cross-thread IDs fail without affecting the agent.
   Repeated decisions cannot change the original outcome.
5. **Disconnects fail closed without cancelling.** Losing a WebSocket client
   does not approve or deny a request and does not cancel the active turn. A
   reconnect can inspect and decide the still-pending request. HTTP/API errors
   also fail closed.
6. **Cancellation and cleanup resolve pending requests as cancelled.** Thread
   cancellation, adapter cancellation, agent exit, turn completion, thread
   deletion, and daemon shutdown release pending waiters. ACP receives the
   protocol's `cancelled` outcome; no request remains usable afterward.
7. **Permission events are transient UI events.** The existing `thread.event`
   bus is used for request and resolution notifications. The persisted chat
   transcript remains user/assistant text, so reconnect behavior is based on
   the pending-permissions endpoint rather than replaying security decisions.

## Consequences

- Browser threads pause visibly instead of relying on headless approve-all.
- A browser must make an explicit one-time decision for each request.
- A lost browser can leave a turn paused until it reconnects or the operator
  cancels it; this is conservative and avoids accidental execution.
- The in-memory broker is intentionally not crash-resumable. A daemon crash
  loses the live ACP process and pending request, consistent with the existing
  conservative crash-recovery model.
