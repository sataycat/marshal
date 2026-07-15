# ADR-0002: Chat Interface — Lightweight Web Client over ACP

**Status:** Proposed
**Date:** 2026-07-15
**Parent:** ADR-0001 (Daemon Webapp)
**Children:** (to be filed — session model, permission mode)

---

## Context

Marshal is pivoting to a **chat-first** Phase 1: the primary deliverable is a usable ACP chat UI in the daemon webapp, with the kanban board deferred to Phase 2. The board was speculative — we don't yet know what workflow shape it should encode. A working chat surface lets us dogfood agent interactions against one or more ACP-compatible coding agents through `acpx`, discover real planning patterns, and build the planning/kanban layer on a foundation of actual usage rather than guesses.

The reference point is **OpenChamber** (the OpenCode companion client) — a lightweight, focused chat surface over an editor — but **web-only** and built on **ACP**, not a native app. Marshal should feel like that kind of tool: a thin, fast, single-window workspace you live in while working with an agent against a repo, not a heavyweight IDE or a board-first project manager.

The chat UI must talk to one or more ACP-compatible coding agents via `acpx` (the headless ACP gateway, see `docs/ARCHITECTURE.md` §agent-layer). acpx streams NDJSON `session/update` events that the daemon's `AcpxAgentAdapter` maps to a typed `AgentEvent` union (`text`, `thinking`, `tool`, `permission`, `log`, `done`, `error`). The UI's job is to render that stream, capture user input (including images and the new "thinking" channel), and stay out of the agent's way.

This ADR scopes the **interface**: what panes exist, what each pane does, how the chat surface renders ACP events, and what affordances the user gets. It deliberately does **not** settle session/state ownership, the daemon thread API, or the permission policy — those are deferred to child ADRs (see "Child ADRs"). ADR-0001 stack constraints (React 18, Tailwind v4, shadcn/Base UI, `<150KB` gzipped initial JS, CodeMirror as the code/markdown engine, light-mode only) and ADR-0001a's routing/layout/perf/accessibility decisions all apply unchanged.

### Why a new interface ADR

The previous ADR-0002 framed the chat work as "session management" — DB schema, thread lifecycle, acpx bookkeeping. Those are real decisions but they are **plumbing**, not the product. Talking about the chat surface as "session management" sets the wrong north star. The product is the interface; the plumbing is in service of it. This revision flips the framing: define the interface first, then let the session/permission/persistence decisions fall out as child ADRs.

---

## Decision

Build a **lightweight, single-window web chat interface** with four panes arranged in one<AppShell>:

1. **Sessions sidebar** (far left)
2. **Files sidebar** (mini project file tree, left of center)
3. **Editor + markdown preview** pane (center)
4. **AI chat** pane (right)

Panes collapse in priority order on smaller viewports; the chat pane is non-collapsible (it is the product), then the editor, then files, then sessions. Mobile shows one pane at a time with bottom-nav. The whole surface is one route group (`/chat`, `/chat/:threadId` — see ADR-0001a §1).

Panes share the existing WebSocket bus that the board uses today; chat is not a new transport, it is a new consumer of the same `thread.*` and run-event subscriptions the daemon already broadcasts.

```
┌───────────────────────────────────────────────────────────────┐
│  Header: Marshal · repo · [agent ▾] · cwd · ws status        │
├──────────┬────────┬─────────────────────────┬────────────────┤
│ Sessions │ Files  │ Editor / Preview        │ Chat            │
│          │        │                          │                │
│ • logs   │ src/   │ # Plan: fix login flush │ user: here's   │
│ • spec   │ ▸ ui   │                          │ the trace...   │
│ ○ draft  │   a.ts │ <preview toggle>        │ ▾ thinking     │
│          │ ...    │                          │   ...          │
│ + New    │ docs/  │ drafted excerpts link    │ assistant: ✓   │
│          │ README │ straight into chat input │ # message...   │
└──────────┴────────┴─────────────────────────┴────────────────┘
        collapse order on narrow viewports:  sessions → files → editor
```

---

## 1. Sessions Sidebar (far left)

A vertical list of the user's threads in this repo, sorted `pinned → last_message_at desc`, with soft-deleted/archived entries hidden by default.

- **One row per thread**: title, agent badge (icon + short agent_id), age, status dot (draft ○, active ●, closed ✓, error !).
- **"+ New thread"** button creates a draft thread with the currently selected agent; no acpx session is created until the first message is sent (zero-cost sessionId = NULL draft). Drafts can be discarded by hovering and clicking ×.
- **Inline actions**: pin, archive, close. Pinned threads always float to top; archived threads are hidden behind a "show archived" toggle at the bottom of the list.
- **Agent filter**: a small dropdown at the top of the sidebar ("all agents" / one of the configured agents). When a thread's `agent_id` differs from the panel-level selector, the row still shows — only the filter narrows.
- **Navigation**: click a row → `/chat/:threadId`; the chat pane swaps, the editor pane's contents swap to that thread's draft context (files sidebar stays repo-wide).
- **Cmd/Ctrl+K** opens a `Dialog` thread switcher (Base UI Dialog, see ADR-0001a §2) with fuzzy match over titles + first message preview — fast keyboard navigation across many threads.

### Why a sidebar over a tab strip
The session list is the user's short-term memory of "what was I doing" across multiple agents and contexts. A sidebar scales to dozens of threads; a tab strip doesn't. Matches Zed/OpenChamber conventions.

---

## 2. Files Sidebar (mini project file tree, center-left)

A slim tree of the repo the agent is operating against, scoped to the thread's `cwd`. Read-mostly: the goal is orientation ("what did the agent just touch? what file are we talking about?") not file management.

- **Tree, not a full file explorer.** No create/rename/delete. Click a leaf → it opens in the Editor pane (read-only by default; an explicit "Edit" affordance flips it to editable CodeMirror — same engine as ADR-0001a §5). Two-click navigation is the bar.
- **Git-aware highlight** (Phase 1 light touch): files with uncommitted changes (vs `HEAD`) get a marker; files the active thread's agent most recently touched (from ACP tool events) get a different marker. Both markers are indicators, not actions.
- **`.git`-style hidden-file policy**: respects `.gitignore`; dotfiles collapsed under a "…" toggle by default.
- **Depth budget**: collapse everything past depth 2 by default — large repos stay scannable. A "…" expander per directory reveals deeper levels on demand.
- **Search box** at the top of the sidebar: client-side fuzzy filter over names (fast, no daemon round-trip for short files; daemon-supported ripgrep filter is a Phase 2 nicety if client filtering becomes slow on the user's repo size).

### Why a files pane at all
Agents work against file paths; the user needs to follow along without leaving the browser to `tree` the repo. A mini file sidebar is the cheapest way to give "which file are we talking about" continuity. It is not a feature surface — it is a map.

---

## 3. Editor + Markdown Preview (center)

A CodeMirror 6 surface (ADR-0001a §5) used **two ways**, switchable by a header toggle:

- **Markdown editor + live preview**: the primary mode. Used to draft specs, prompts, notes, or excerpts to send the agent. The preview pane renders `marked`-to-HTML for prose and CodeMirror-stub hydration for code blocks — same path as chat message rendering, so drafts preview identically to how the agent will see them.
- **File viewer/editor**: when a file is clicked in the Files sidebar, the same surface loads the file in CodeMirror with the right `@codemirror/lang-*`. The toggle switches to "preview" only for markdown files (renders the file); other files stay edit-only.

Per-thread, the editor holds **scratch state**: the in-progress draft the user is authoring. Scratch survives pane swap and reload (persisted to the daemon — see child session ADR for the persistence surface); it is the "what was I about to send" buffer.

### Send-to-chat affordance
A "Send to chat" button (and `Cmd+Enter`) pushes the editor's markdown contents as a user message in the chat pane and either clears (default) or retains (toggle) the scratch buffer. Excerpts of files (#-mention syntax, see §4) pull from the Files sidebar; typing `@path/to/file.ts` in the editor (or in the chat input) attaches that file's contents inline to the outgoing message. Selecting text in the file view and pressing `Cmd+Shift+E` inserts the selection as a fenced excerpt into the draft.

This is the "OpenChamber-like" loop: author the thought as markdown, preview it as the agent will see it, send it, watch the agent stream a reply, repeat.

---

## 4. AI Chat Pane (right)

The product surface. Renders conversation messages from ACP events and accepts new input.

### Message rendering

Messages are typed by role and rendered by event variant. The `AcpxAgentAdapter` already maps ACP `session/update` notifications to an `AgentEvent` union (`text`, `thinking`, `tool`, `permission`, `log`, `done`, `error` — `docs/ARCHITECTURE.md` §agent-layer). Each variant gets a treatment:

| Event variant  | Render                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------- |
| `text`         | Markdown bubble. Inline `marked`-to-HTML; code fences hydrate a read-only `<CodeBlock>`.            |
| `thinking`     | Collapsible block under the preceding assistant turn. Rendered as muted markdown. **Off by default**, expanded affordance (`▾ thinking`) per turn and "Show all thinking" toggle per thread. The thinking channel is forwarded by acpx when the upstream agent emits it; Marshal doesn't synthesize it. |
| `tool`         | Tool-call card: tool name, args (collapsed JSON), status (▶ running / ✓ done / ✗ error), and a "view output" expander. "Open the touched file" jumps to it in the Files sidebar + Editor. Not inline-rendered output by default — dense stdout is the noise we want to collapse. |
| `permission`   | Inline dialog inside the turn: "Agent wants to <action> <arg>". Approve / Deny buttons. Headless/`approve-all` is still the default for builder/validator runs; interactive threads in the web UI surface approval inline so the user can opt into stricter permission modes per thread. (Full policy in a child permission ADR.) |
| `log`           | One-line system log entries — server stdout that doesn't belong to a variant. Neutral styling.     |
| `done`         | Marks the end of an assistant turn; closes the streaming cursor.                                    |
| `error`        | Red card with the error text and a "Retry"/"Reconnect" affordance. Thread status flips to `error`. |

Streaming messages show a blinking cursor (`█`) and incrementally append; partial markdown is still rendered (re-render on each NDJSON line). Backpressure and reconnection are the adapter's job, not the UI's.

### Inputs

- **Textarea** at the bottom: multiline with markdown preview-on-focus (a small ghost preview shows the rendered version below the input on hover/focus; collapses when blurred). `Enter` to send, `Shift+Enter` for newline (toggle-able in settings, but defaults match every other chat app).
- **Image uploads**: a paperclip / drag-and-drop onto either the editor or the chat input. Images are POSTed to a daemon upload endpoint (multipart, scoped to the thread), and the returned attachment ref is inserted as a markdown image with a `data-attachment-id`. ACP image support is forwarded as ACP's image content parts when supported by the agent; if the agent doesn't accept images, the daemon surfaces a clear error before the send completes (no silent drop). Max size and accepted MIME types are daemon-config-defined (Phase 1 generous defaults: 10MB, png/jpeg/webp/gif).
- **File mentions**: typing `@` opens a fuzzy file picker (Base UI `Combobox`) sourced from the Files sidebar. Selecting inserts `@<relpath>` which the daemon expands to file contents inline at send time (`@path/to/file.ts` → the file's text wrapped in a fenced block).
- **Agent selector**: top-level dropdown showing the configured agents from `~/.marshal/config.json` (`AGENT_ID_DEFAULTS`) or repo-level `marshal.json`. New threads inherit it; opening an existing thread does not change it (the thread carries its own `agent_id`). Same model as Zed.
- **Cancel** affordance: while a turn is streaming, the send button flips to a "Stop" that calls `acpx <agent> cancel -s marshal-<id>`. The turn ends in a `done`/`error` state and the user can edit-and-resend the prompt.
- **Edit-and-resend**: hover a past user message → "Edit" affordance → opens the message back in the input editor; resending forks the conversation (appends a new turn after the edited prompt, keeping the original history). Resend-by-regenerate ("↻ Retry") on an assistant turn re-issues the preceding user prompt.

### Thinking affordance details

ACP exposes `thinking` as a structured notification. Marshal treats it as a **first-class but de-emphasized** channel:
- Each `thinking` block is a separate collapsed unit under its assistant turn (one turn may have several).
- Default state is collapsed; the affordance is a "▾ thinking" button inline; expanding does not move the rest of the conversation.
- A per-thread "Show all thinking" toggle expands every block; the toggle is sticky per thread.
- Search (future) over a thread includes thinking blocks.
- The UI does **not** show thinking with a delay/pulse "agent is thinking…" animation that some clients use to fake liveliness — the streaming cursor on the `text` channel already does that job, and faking is worse than honest quiet.

---

## 5. Session / Thread Model (summary — full treatment in child ADR)

The interface needs a notion of "what conversation am I in" that survives pane swap, reload, and agent crash. This is the **thread**: a UI-level unit that maps 1:1 to an acpx named session once the first message is sent. Marshal owns thread metadata (title, agent_id, cwd, status, archived, pinned, last_message_at, future `task_slug`) and a message cache; it never reads `~/.acpx/sessions/*.json` directly — the acpx CLI is the only stable contract.

Lifecycle: `draft` (no acpx session, zero-cost) → `active` (first message triggers `acpx <agent> sessions new --name marshal-<id8>`) → `closed` (explicit close) or `error` (agent died, retry affordance). Drafts are essential for the sidebar UX — a "+ New" thread is free until you actually send.

The exact DB schema, cache depth, title-generation policy, cross-tool visibility rules, and resumption semantics are deferred to a **child "Chat Session Model" ADR** because they're backend/daemon decisions, not interface ones. This ADR only asserts the shape the interface depends on: stable thread UUIDs that deep-link to `/chat/:threadId`, draft state that costs nothing, per-thread agent_id, and acpx as the sole agent substrate.

---

## 6. What the Phase 1 UI deliberately omits

To stay light and ship:

- **No board/kanban** (Phase 2).
- **No task lineage view** beyond the optional `task_slug` badge on a thread.
- **No diff/hunk view surfaced in chat** — diffs surface in ACP `tool` events (the agent reports what it changed); a dedicated diff view is Phase 2.
- **No dark mode** (ADR-0001 §3).
- **No agent config UI** — agents come from `~/.marshal/config.json` / repo `marshal.json`; editing them is `marshal init` / `marshal doctor`'s job, not the webapp's.
- **No multi-repo in one window** — one repo per session group; second repo = second browser tab to a second daemon.
- **No full file explorer** — the Files sidebar is read-mostly; create/rename/delete is a job for the agent or the user's editor.

---

## Consequences

### Positive

- **Single surface, single mental model.** Sessions + files + draft editor + chat in one pane group. The user never context-switches apps mid-thought.
- **Markdown-first authoring.** Authoring prompts/specs as previewed markdown in the editor, then sending, matches how agents actually consume input — no translation loss between "what you wrote" and "what the agent sees."
- **ACP-native, agent-agnostic.** Everything the chat renders comes from the `AgentEvent` union the acpx adapter already emits. Supporting a new agent is config; the UI doesn't change.
- **Thinking and image upload first-class.** Both are ACP realities for modern agents; treating them as core rather than bolt-ons means we don't retrofit them later.
- **Cheap drafts.** Draft threads cost nothing on the agent side, so the sidebar can host many half-formed ideas without burning session slots.
- **Phase 2 runway.** The thread model is the bridge to the kanban: a task's spec-authoring chat is a thread with `task_slug`; builder/validator runs are threads; the board filters "task threads" vs free threads. Building chat first means the board isn't speculative.

### Negative / Risks

- **Four panes risk density.** On a 13" laptop this could feel cramped. Mitigation: collapse order (sessions → files → editor) and the mobile single-pane + bottom nav (ADR-0001a §2). Revisit pane widths after dogfooding.
- **"Editor + preview + chat" is three rendering modes.** Three CodeMirror/marked paths to keep consistent (draft preview, file viewer, chat message rendering) all route through the same hydration path (ADR-0001a §5), but the wires multiply. Mitigation: one `<CodeBlock>` component, one `markdownToHtml` helper; no per-surface forks.
- **Image upload path crosses a daemon boundary.** Multipart upload + size/MIME validation + ACP image-part conversion is the most new daemon-side surface in this ADR. Mitigation: small, dedicated `/api/threads/:id/attachments` endpoint; reject early with a clear error if the agent doesn't accept image parts.
- **Thinking blocks can dominate long turns.** Some agents emit kilobytes of thinking. Mitigation: per-block collapse default, per-thread "show all" toggle, and include thinking in thread search so users don't lose context by hiding it.
- **Wireframe-driven scope creep.** Each pane has tempting "one more feature" (renames in files, full diff in chat, agent config UI). This ADR explicitly scopes them out (§6); the collapsed-by-default files tree and the omitted surfaces are the discipline.

---

## Alternatives Considered

1. **Single chat pane only (no editor, no files sidebar).** Rejected. The OpenChamber-style 4-pane is what makes the surface feel like a working tool rather than a chat app bolted onto a repo. Stripping to chat-only loses "where is the agent working" and "let me draft this properly." It's the difference between a Slack-with-an-agent and a workbench.

2. **Editor + preview as a modal, not a pane.** Rejected. Authoring specs and prompts is a continuous activity, not an occasional one; a modal hides the chat while you draft and forces a context switch. A persistent pane keeps the agent's last reply visible as you write the next.

3. **Files sidebar as a full file explorer (create/rename/delete).** Rejected. The agent is the one mutating files; the user's file operations are noise against an agent-driven workflow. The pane is a map for orientation, and a "jump to file" affordance for excerpts. Adding write operations duplicates the agent's job and complicates permission reasoning.

4. **Per-session agent selector (each thread has its own selector in its row).** Rejected. Top-level agent selector + per-thread `agent_id` (Zed's model) is simpler — the user is "working with OpenCode right now" and new threads inherit that; opening an old Codex thread just resumes Codex. Per-session selectors suggest switching agents mid-thread, which isn't a sane primary action.

5. **Render thinking inline and expanded by default.** Rejected. Thinking blocks are often long, noisy, and not what the user came for; expanded-by-default buries the actual responses. Muted-and-collapsible keeps the transcript readable while preserving the data when the user wants it.

6. **Fake "agent is thinking…" pulse during the gap between user send and first token.** Rejected. The streaming cursor on the `text` channel is honest signal; a fake animation during the latency window makes the tool feel less truthful, not more. Quiet is fine.

7. **Image attachments as URL-references only (no upload UI).** Rejected. Most users don't have a self-hosted image backend they want to paste into. A drag-and-drop upload to the daemon is the path of least resistance for "drop a screenshot of the error into the chat," which is a core screenshot-the-bug loop.

8. **Sidebar tabs to switch between Sessions / Files / one-at-a-time.** Rejected as a default — costs two panes worth of information density for screen real estate that desktop realistically has. Collapsing by priority order (§decision) already covers small screens without forcing a tab model on desktop. Tabs can be a Phase 2 nicety if dogfooding shows the 4-pane layout is too dense at <1280px width.

---

## Child ADRs (to be filed)

| ID (TBD) | Topic                  | Scope                                                                                       |
| -------- | ---------------------- | ------------------------------------------------------------------------------------------- |
| TBD      | Chat Session Model     | Thread DB schema, cache depth, title-gen policy, resumption semantics, cross-tool visibility, daemon thread API surface, WS event extensions (`thread.*`). |
| TBD      | Chat Permission Mode   | Interactive thread permission policy: per-thread mode, defaults, inline approval UX contract with `AgentEvent.permission`. |
| TBD      | Chat Attachments       | Image/file upload endpoint, MIME/size limits, ACP image-part conversion, fallback when agent rejects images. |

---

## Open Questions

1. **Pane widths + collapse threshold.** At what viewport width does the Files sidebar auto-collapse? At what width does Sessions collapse into the header? Pin numbers after dogfooding; default to ≥1280px shows all four, 1024–1280 collapses Files, <1024 collapses Sessions, <768 mobile single-pane + bottom nav.
2. **Editor scratch persistence shape.** Is scratch state per-thread, per-repo, or pane-global? Per-thread matches "what was I about to send"; pane-global matches "my notes." Lean per-thread with a "scratch bake into notes" affordance later.
3. **Thinking rendering fidelity.** Some agents stream thinking as plain text, others as structured labeled blocks (model name, duration). Phase 1 treats it as opaque muted markdown; richer structure can be a Phase 2 enrichment without breaking the collapsed affordance.
4. **File-mention expansion target.** When `@path/to/file.ts` is sent, is the expansion inserted into the saved message (visible in history) or kept as a server-side reference post-send (history shows the mention, daemon expanded it for the agent)? Lean: insert into saved message so history is self-explanatory, even at the cost of larger messages.
5. **Multi-image batches and paste-from-clipboard.** Drag-and-drop multiple files and screenshot paste (`Cmd+V`) into the input both need to work; details land in the Chat Attachments child ADR.