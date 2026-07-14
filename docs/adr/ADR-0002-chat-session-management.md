# ADR-0002: Chat Session Management — Hybrid Thread Model

**Status:** Proposed  
**Date:** 2025-07-14  
**Parent:** ADR-0001  
**Children:** (to be filed)

---

## Context

Marshal is pivoting to a **chat-first** Phase 1: the primary deliverable is an ACP chat UI (similar to OpenChamber for OpenCode), with the kanban board deferred to a later phase. This lets us dogfood agent interactions, discover real workflow patterns, and build the planning/kanban layer on a foundation of actual usage.

The chat UI must manage sessions against one or more ACP-compatible coding agents via acpx. This raises a core design question: **who owns session state?**

### How acpx manages sessions

acpx stores sessions as JSON files at `~/.acpx/sessions/`, scoped by the tuple `(agentCommand, cwd, name)`. Key properties:

- Sessions survive process exits (disk-based persistence)
- Named sessions (`-s backend`, `-s docs`) allow multiple independent sessions per repo
- Queue-owner pattern: one process holds the ACP connection; others submit via Unix socket IPC
- Lifecycle: `sessions new` / `ensure` / `close` / `prune`
- Full conversation history stored in the session record (`messages: SessionMessage[]`)
- Session states: running, idle, dead, no-session

### How Zed (the reference ACP client) handles it

Zed uses a **two-layer hybrid** model:

1. **Content layer** — SQLite (`threads.db`), stores full conversation as zstd-compressed blobs
2. **Metadata layer** — separate SQLite, lightweight display data (title, agent_id, worktree paths, timestamps, archived flag)

Key design choices in Zed:

- Agent selector is **panel-wide** (per workspace), not per-session. But each thread carries its own `agent_id` — restoring an old thread restores its agent.
- Threads start as **drafts** (no ACP session created yet). `session_id` is filled in only after the first message triggers `session/create`. This decouples UI lifecycle from agent lifecycle.
- Up to 5 threads retained in memory; rest evicted but kept on disk.
- Thread switcher modal (Cmd+Tab style) for fast navigation.

### Three approaches considered

| Approach      | Description                                                                                  | Tradeoff                                   |
| ------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **A. Mirror** | Marshal creates acpx sessions, mirrors state in its own DB                                   | Full control, dual bookkeeping             |
| **B. Proxy**  | Marshal is pure UI over acpx's session store                                                 | Simple, but limited metadata/customization |
| **C. Hybrid** | Marshal owns its own "thread" concept with UI metadata; maps 1:1 to acpx sessions underneath | Best UX flexibility, moderate complexity   |

---

## Decision

**Approach C: Marshal owns a thread abstraction that wraps acpx sessions.**

Marshal maintains its own thread metadata and conversation cache in SQLite. Each thread maps 1:1 to an acpx session underneath. The thread is the UI-level unit; the acpx session is the protocol-level unit. Marshal never reads from `~/.acpx/sessions/` directly — it interacts with acpx exclusively through the CLI/process interface.

### Data Model

```sql
-- Thread metadata (lightweight, for sidebar/list rendering)
CREATE TABLE threads (
    id TEXT PRIMARY KEY,                  -- UUID, marshal-generated
    acpx_session_id TEXT,                 -- NULL until first message (draft state)
    agent_id TEXT NOT NULL,               -- e.g. "opencode", "codex", "claude"
    title TEXT,                           -- user-editable or agent-generated
    cwd TEXT NOT NULL,                    -- absolute path (repo root)
    session_name TEXT,                    -- acpx named session (optional)
    status TEXT NOT NULL DEFAULT 'draft', -- draft | active | closed | error
    created_at TEXT NOT NULL,             -- ISO 8601
    updated_at TEXT NOT NULL,             -- ISO 8601
    last_message_at TEXT,                 -- for sort order
    archived INTEGER NOT NULL DEFAULT 0,  -- soft-delete for sidebar
    pinned INTEGER NOT NULL DEFAULT 0,    -- user-pinned threads float to top
    task_slug TEXT                         -- nullable FK to tasks table (future kanban link)
);

-- Conversation messages (cached from acpx stream)
CREATE TABLE thread_messages (
    id TEXT PRIMARY KEY,                  -- UUID
    thread_id TEXT NOT NULL REFERENCES threads(id),
    role TEXT NOT NULL,                   -- user | assistant | system | tool
    content TEXT NOT NULL,                -- markdown content
    tool_name TEXT,                       -- if role=tool
    seq INTEGER NOT NULL,                 -- monotonic ordering within thread
    created_at TEXT NOT NULL,
    metadata TEXT                         -- JSON blob for agent-specific data
);
```

### Thread Lifecycle

```
┌──────────┐     first message      ┌──────────┐
│  draft   │ ─────────────────────▶ │  active  │
└──────────┘    (acpx sessions new) └──────────┘
                                          │
                              close / agent exit
                                          ▼
                                    ┌──────────┐
                                    │  closed  │
                                    └──────────┘
```

1. **Draft**: Thread exists in Marshal's DB with a chosen `agent_id` and `cwd`. No acpx session created. Zero cost.
2. **Active**: First user message triggers `acpx <agent> sessions new --name <session_name>` (or `sessions ensure`). The `acpx_session_id` is recorded. Messages stream via NDJSON.
3. **Closed**: User explicitly closes, or the acpx session is soft-closed. Thread remains in DB for history.
4. **Error**: Agent spawn failed or session entered unrecoverable state. Surfaced in UI with retry affordance.

### Agent Selector

**Top-level, panel-wide selector** — mirrors Zed's approach:

- A dropdown at the top of the chat surface selects the active agent (from the configured agents in `~/.marshal/config.json` → `AGENT_ID_DEFAULTS` or the repo-level `marshal.json`)
- New threads inherit the selected agent
- Existing threads carry their own `agent_id`; opening an old thread does NOT change the top-level selector
- Sidebar shows all threads regardless of agent, with an agent icon/badge on each entry
- Optional filter: "show only threads for agent X"

**Rationale for panel-wide over per-session**: Simpler mental model for Phase 1. You're "working with OpenCode right now." If you open an old Codex thread, it resumes with Codex — but your next new thread will use whatever's selected. This matches how people switch between tools.

### Session Name Strategy

Each Marshal thread gets a deterministic acpx session name to avoid collisions and enable resumption:

```
marshal-<thread_id_short>
```

Where `thread_id_short` is the first 8 chars of the thread UUID. This:

- Avoids colliding with user's own acpx sessions (namespaced with `marshal-`)
- Allows acpx `sessions ensure` for reconnection after marshal restarts
- Is human-readable in `acpx <agent> sessions list` output

### Interaction with acpx

Marshal interacts with acpx exclusively via CLI subprocess:

| Operation      | acpx command                                               |
| -------------- | ---------------------------------------------------------- |
| Create session | `acpx <agent> sessions new --name marshal-<id>` in cwd     |
| Resume session | `acpx <agent> sessions ensure --name marshal-<id>`         |
| Send prompt    | `acpx <agent> -s marshal-<id> '<prompt>'` (streams NDJSON) |
| Cancel         | `acpx <agent> cancel -s marshal-<id>`                      |
| Close          | `acpx <agent> sessions close marshal-<id>`                 |
| Check status   | `acpx <agent> status -s marshal-<id>`                      |

Marshal reads the NDJSON event stream from acpx's stdout, maps ACP events to `thread_messages`, and broadcasts to connected WebSocket clients for live rendering.

### No Direct acpx Store Access

Marshal **never** reads `~/.acpx/sessions/*.json` directly. Reasons:

1. acpx's storage format is internal and may change between versions
2. The queue-owner pattern means files may be locked/in-flight
3. acpx CLI is the stable interface; file layout is not
4. Marshal's own DB is the source of truth for UI state

If the user runs acpx directly outside Marshal, those sessions are invisible to Marshal's UI. This is intentional — Marshal manages its own threads; acpx sessions created outside Marshal are the user's own concern.

### WebSocket Events (additions to existing bus)

```typescript
type ThreadEvent =
  | { type: "thread.created"; thread: ThreadMetadata }
  | { type: "thread.updated"; thread: ThreadMetadata }
  | { type: "thread.message"; threadId: string; message: ThreadMessage }
  | { type: "thread.status"; threadId: string; status: ThreadStatus }
  | { type: "thread.closed"; threadId: string }
  | { type: "thread.error"; threadId: string; error: string };
```

These extend the existing WebSocket event bus (task.created, task.updated, etc.) — same connection, same pattern.

### Relationship to Tasks (future)

The `task_slug` column on `threads` is nullable and unused in Phase 1. When the kanban layer arrives:

- A task's spec-authoring chat becomes a thread with `task_slug` set
- Builder/validator runs may spawn threads viewable in the UI
- The thread list can filter by "task threads" vs "free threads"

This is the bridge between chat-first and kanban-later — threads are the universal conversation unit.

---

## UI Layout (Phase 1, chat-only)

```
┌─────────────────────────────────────────────────────────┐
│  Header: Marshal · repo name · [agent selector ▾] · ws  │
├────────────────┬────────────────────────────────────────┤
│                │                                        │
│  Thread list   │  Chat pane                             │
│  (sidebar)     │  (messages, streaming, input)          │
│                │                                        │
│  • Thread 1    │  ┌────────────────────────────────┐   │
│  • Thread 2    │  │ assistant: Here's the fix...   │   │
│  ○ Thread 3    │  │ user: Can you also add tests?  │   │
│    (draft)     │  │ assistant: ███ (streaming)     │   │
│                │  └────────────────────────────────┘   │
│  [+ New]       │                                        │
│                │  ┌────────────────────────────────┐   │
│                │  │ > type a message...        [⏎] │   │
│                │  └────────────────────────────────┘   │
├────────────────┴────────────────────────────────────────┤
│  Status: opencode · idle · ~/.../my-repo                │
└─────────────────────────────────────────────────────────┘
```

The board/kanban is absent in Phase 1. When it arrives, it becomes a second "surface" toggled via tabs or layout — but the chat pane and thread model stay unchanged.

---

## Consequences

### Positive

- **Decoupled UI lifecycle from agent lifecycle.** Draft threads, agent crashes, reconnections — all handled gracefully because Marshal owns its own state.
- **Rich metadata without fighting acpx.** Titles, pins, archives, task links, timestamps — all in Marshal's DB where they belong.
- **Future-proof.** The thread model is the foundation for kanban integration, multi-agent workflows, and session search/history.
- **Dogfood-ready.** A working chat UI from Phase 1 enables discovering real planning patterns before building the kanban.
- **Agent-agnostic.** Agent selector + per-thread agent_id means switching agents or adding new ones is pure config.

### Negative / Risks

- **Dual state.** Marshal's DB and acpx's session store can drift (e.g., user closes an acpx session outside Marshal). Mitigation: status checks on thread open; stale sessions surface an error state with "reconnect" or "close" affordance.
- **No cross-tool session visibility.** Sessions created directly via `acpx` CLI won't appear in Marshal's UI. This is a feature (separation of concerns) but may confuse users who expect unification. Document clearly.
- **NDJSON streaming complexity.** Parsing acpx's NDJSON output, handling partial lines, backpressure, and reconnection adds implementation weight. Mitigation: well-tested stream adapter, reuse the existing run_events pattern from the builder/validator flow.
- **No offline history beyond cache.** If Marshal's DB is lost, thread history is gone (acpx sessions may still exist but Marshal can't discover them by ID). Mitigation: DB is in the repo-local `.marshal/` — backed up with the repo.

---

## Alternatives Considered

1. **Approach A (Mirror): Bidirectional sync with acpx store.** Rejected. Reading `~/.acpx/sessions/*.json` couples Marshal to acpx's internal format and creates race conditions with the queue-owner pattern. The CLI is the stable contract.

2. **Approach B (Proxy): Pure UI layer over acpx sessions.** Rejected. Too limiting — no draft threads, no custom metadata, no pinning/archiving, no task links. Every UI feature would require acpx to add support upstream.

3. **Global agent selector that hides other agents' threads.** Rejected. Zed's model (show all, badge by agent) is better UX — you can see your full history regardless of which agent is currently selected.

4. **One thread per repo (singleton session).** Rejected. Named sessions in acpx exist precisely because people want multiple concurrent conversations in the same codebase (e.g., one for a bug fix, one for a feature, one for exploration).

5. **Import existing acpx sessions into Marshal on first run.** Deferred. Could be a `marshal import-sessions` command later, but it's not needed for Phase 1 and adds complexity around session format assumptions.

---

## Open Questions

1. **Thread title generation.** Should Marshal ask the agent to generate a title after the first exchange (like Zed does), or leave it to the user? Likely: auto-generate with user override.
2. **Message cache depth.** Cache all messages in Marshal's DB, or only recent N? Full cache is simpler and enables local search; but large conversations could be heavy. Start with full cache; revisit if DB size becomes a concern.
3. **Multi-repo threads.** Current model scopes threads to a single `cwd`. If a user works across repos, do they want one thread spanning multiple repos, or separate threads? Start with single-cwd; revisit.
4. **Permission mode.** Marshal currently uses `approve-all` for headless builder/validator runs. Interactive chat likely wants a different policy (or surfaces permission requests in the UI). Needs a child ADR.
