# ADR-0002 Chat UI TODO

This is the implementation breakdown for the chat-first Phase 1 described in
[`docs/adr/ADR-0002-chat-interface.md`](docs/adr/ADR-0002-chat-interface.md).
Each slice should be large enough for one coding agent to complete in a single
pass and should leave behind observable, working behavior.

## Principles

- Prefer vertical slices over isolated backend or frontend work.
- Keep the daemon as the source of truth; the web client stays thin.
- Keep each slice independently testable and reviewable.
- File child ADRs when a slice requires a new durable or security-sensitive decision.
- Do not build the full four-pane workbench before a basic chat loop works.

## Dependency Map

```text
Slice 1 ──> Slice 2 ──> Slice 3 ──> Slice 4 ──> Slice 5
                                  ├─> Slice 6
                                  └─> Slice 7 ──> Slice 8
```

## Slices

### Slice 1 — Chat Session Model [done]

**Goal:** Define and persist Marshal-owned chat threads and messages.

**Scope:**

- File the Chat Session Model child ADR.
- Add thread and message persistence with draft, active, closed, and error states.
- Establish stable thread IDs, per-thread agent identity, titles, timestamps, and repo/cwd ownership.
- Define the daemon API and WebSocket events needed by later slices.
- Add focused persistence and lifecycle tests.

**Outcome:** The daemon can create, list, open, and update a thread without starting an agent process.

### Slice 2 — First Chat Turn [done]

**Goal:** Send one message to a configured ACP agent through a thread.

**Scope:**

- Connect a thread to the direct ACP adapter on its first sent message.
- Stream assistant events into durable messages and the existing WebSocket bus.
- Support completion, cancellation, and error states.
- Preserve the existing task/spec chat behavior.
- Add an end-to-end daemon test using a fake ACP process.

**Outcome:** A client can create a thread, send a message, receive a streamed response, reload it, and see the conversation history.

### Slice 3 — Minimal Chat Route [done]

**Goal:** Expose the first usable browser chat surface.

**Scope:**

- Add `/chat` and `/chat/:threadId` routing.
- Add a thread list and a single chat pane.
- Add message input, streaming transcript rendering, loading, cancellation, and error/retry states.
- Reuse the existing WebSocket connection and markdown/code rendering.
- Make the route usable on desktop and mobile.

**Outcome:** A human can use Marshal in the browser for a complete basic chat loop.

### Slice 4 — Thread Management UX [done]

**Goal:** Make multiple conversations practical to use.

**Scope:**

- Add new-thread, draft, close, archive, pin, and delete/discard behavior.
- Show thread status, agent identity, title, and recent activity.
- Add navigation and refresh-safe deep links.
- Add the basic agent selector for new threads.
- Add the thread switcher interaction described by ADR-0002.

**Outcome:** A user can keep and switch between several conversations without losing context.

### Slice 5 — Editor And Markdown Drafting [done]

**Goal:** Add the drafting workflow that differentiates Marshal from a generic chat box.

**Scope:**

- Add the editor/markdown-preview pane.
- Support per-thread scratch drafts and send-to-chat.
- Support keyboard send and the basic edit/resend flow.
- Reuse the existing CodeMirror and markdown pipeline.
- Persist scratch state according to the session-model decision.

**Outcome:** A user can compose a longer markdown prompt, preview it, send it, and continue from the same workspace.

### Slice 6 — Files Sidebar And Context [done]

**Goal:** Give the user lightweight awareness of the repository the agent is using.

**Scope:**

- Add the read-mostly files tree for the thread cwd.
- Support search, basic expansion, and opening a file in the editor.
- Add lightweight changed/recently-touched indicators where the daemon already has the information.
- Support file mentions or selected excerpts in the drafting/chat flow at the level agreed by ADR-0002.

**Outcome:** A user can find the relevant file, inspect it, and include focused repository context in a message.

### Slice 7 — Interactive Permissions [done]

**Goal:** Let browser-driven threads handle ACP permission requests safely.

**Scope:**

- File the Chat Permission Mode child ADR.
- Define the daemon permission broker and thread-level policy.
- Render inline permission requests with approve/deny actions.
- Resume or fail the active turn correctly after a decision.
- Cover disconnects, cancellation, and denied permissions.

**Outcome:** An interactive thread can pause for a permission decision and continue without relying on headless approve-all behavior.

### Slice 8 — Attachments And Final Phase 1 Polish [done]

**Goal:** Complete the core chat-first workflow and make it ready for dogfooding.

**Scope:**

- File the Chat Attachments child ADR.
- Add image upload, validation, persistence, and ACP image-part forwarding where supported.
- Add clear unsupported-image and upload-error handling.
- Finish responsive pane collapse and mobile navigation.
- Add reconnect handling, empty states, and the key human-testing flow.
- Update architecture and human-testing documentation.

**Outcome:** The Phase 1 chat workbench supports text, repository context, permissions, and images well enough for sustained real-agent use.

## Deferred Until After Phase 1

- Kanban/board redesign and task lineage views.
- Full file management operations.
- Multi-repo workspaces.
- Dark mode.
- Advanced search across threads and thinking blocks.
- Durable ACP session resumption after daemon crashes.
