# ADR-0001: Daemon Webapp — Full-Featured Web Client

**Status:** Proposed (sequencing revised — chat-first)  
**Date:** 2024-07-14  
**Parent:** —  
**Children:** ADR-0001a (Frontend Infrastructure), ADR-0002 (Chat Interface)

---

## Context

Marshal's daemon already serves a thin Vite + React SPA (kanban board, task detail, spec chat, diff view). The existing frontend was built as a minimal M1 deliverable — proof that the daemon API works and tasks are driveable from a browser.

The webapp is the **primary interface** for most users. The CLI and future TUI are power-user tools; the board is the default surface people will live in. That makes this not a "nice SPA polish pass" but a strategic investment: the webapp needs to become a full-featured, responsive, lightweight application that is pleasant to use all day.

Two key gaps in the current frontend:

1. **It's board-only.** The kanban view works, but there's no conversational surface beyond the spec-authoring chat scoped to a single task. Users need an ambient chat interface (like OpenChamber / Cursor-style chat) for repo-level questions, multi-task planning, ad-hoc agent conversations, and interactive debugging — all without leaving the webapp.

2. **It's not production-quality UX.** No responsive layout, no keyboard navigation, no loading states, no empty states, no error boundaries, no accessibility, no performance budget. It works on a laptop; it doesn't work on a phone, doesn't feel polished, and would not score well on Lighthouse.

### Design tenets that apply

- **Thin clients, fat daemon** (PROJECT.md §2.7): The webapp is a face over the API. No durable client-side state. The daemon is authoritative.
- **Verification is the product** (PROJECT.md §2.1): The webapp must surface gate results, failure context, and retry state clearly — not bury them.
- **Minimize HITL to the two ends** (PROJECT.md §2.3): The webapp's job is to make spec authoring and merge review fast and confident, then get out of the way.

---

## Decision

Build out the daemon webapp into a **fully-featured, responsive, lightweight web client** with two primary surfaces: the **board** (kanban + task lifecycle) and a **chat interface** (repo-level and task-scoped conversations). The webapp remains a thin client over the existing HTTP + WebSocket API.

### Architecture Principles

1. **Single SPA, client-side routing.** One Vite build, one `index.html`, routes handled client-side. The daemon serves `web/dist/` as-is.

2. **Responsive-first layout.** Desktop shows board + detail side-by-side (or board + chat). Tablet collapses to stacked. Mobile shows one surface at a time with navigation. Breakpoints: ~768px (tablet), ~480px (phone).

3. **Performance budget.** Target Lighthouse scores: Performance ≥90, Best Practices ≥95. Accessibility is **not** gated or tracked — it is inherited from the Base UI primitive layer underneath shadcn (see ADR-0001a §4). Bundle budget: <150KB gzipped JS (excluding source maps). No heavy UI framework. Vanilla CSS (custom properties, no Tailwind, no CSS-in-JS). React 18 stays — it's already there and adequate.

4. **No new runtime dependencies without justification.** `marked` stays for markdown. Anything else needs a child ADR. The bias is toward small, focused libraries or hand-rolled solutions.

### The Two Surfaces

**Delivery sequence: Chat first (Phase 1), Board second (Phase 2).** The chat UI is the immediate deliverable — it provides a usable ACP interface, enables dogfooding, and surfaces real workflow patterns that inform the kanban design. The board evolves from the existing minimal kanban once the chat-driven workflow is understood. See ADR-0002 for the chat interface design.

#### Chat (Phase 1 — primary surface)

A conversational interface that is the **sole Phase 1 UI surface**:

- **Repo-level chat**: not scoped to a single task. For asking questions about the codebase, planning work, discussing architecture, or interacting with agents for ad-hoc tasks.
- **Task-scoped chat** (Phase 2 bridge): the existing spec-authoring chat, upgraded to feel like a first-class conversation (streaming responses, markdown rendering, code blocks with syntax highlighting). Becomes a "thread with a task_slug" once the kanban arrives.
- **Agent selector**: top-level dropdown for the active agent, with per-thread agent identity for history. See ADR-0002.
- **Session management**: threads are Marshal-owned abstractions wrapping ACP sessions. Draft → Active → Closed lifecycle. See ADR-0002.
- **Streaming**: ACP events are mapped by the daemon and broadcast to the UI via the existing WebSocket bus.

#### Board (Phase 2 — builds on chat foundation)

The existing kanban board, evolved once chat-driven workflows reveal what the board needs to be:

- **Responsive columns**: horizontal scroll on desktop, vertical stack on mobile.
- **Task card enrichment**: show active run status (building/validating), time-in-state, retry count badge, last failure summary.
- **Inline actions**: transition buttons on cards (where valid), drag-to-reorder backlog.
- **Filtering and search**: by status, by text, by age.
- **Empty states and loading skeletons**.
- **Keyboard navigation**: arrow keys across columns/cards, Enter to open detail.

#### Chat (Phase 2 — task-scoped, evolved from Phase 1 threads)

Once the kanban arrives, task-scoped threads emerge naturally from the Phase 1 chat model:

- **Repo-level chat**: not scoped to a single task. For asking questions about the codebase, planning work, discussing architecture, or interacting with agents for ad-hoc tasks.
- **Task-scoped chat**: the existing spec-authoring chat, upgraded to feel like a first-class conversation (streaming responses, markdown rendering, code blocks with syntax highlighting).
- **Seamless switching**: chat panel can dock beside the board or open full-screen on mobile. Task-scoped threads are reachable from both the chat surface and the task detail.
- **Agent-backed**: threads hit the daemon API, which routes to the configured direct ACP command. The daemon manages session lifecycle; the webapp renders the stream. See ADR-0002 for the session model.

> **API gap**: The current API has spec-chat (`/api/tasks/:slug/spec-messages`) but no repo-level chat endpoint. ADR-0002 defines the thread/session model; daemon-side API additions for threads will be implemented as part of Phase 1 delivery.

### Information Architecture

```
┌─────────────────────────────────────────────┐
│  Header: Marshal · repo name · ws status    │
├──────────────┬──────────────────────────────┤
│              │                              │
│   Board /    │   Detail panel               │
│   Chat       │   (task detail, diff,        │
│   (primary)  │    run log, spec chat)       │
│              │                              │
│   [tabs or   │   — or —                     │
│    toggle]   │                              │
│              │   Chat panel                 │
│              │   (repo-level or task chat)  │
│              │                              │
├──────────────┴──────────────────────────────┤
│  Status bar: daemon status, active task     │
└─────────────────────────────────────────────┘

Mobile: single-panel with bottom nav
(Board | Chat | Detail)
```

### Styling and Component Approach

- **shadcn/ui pattern (Base UI primitives + Tailwind CSS).** Components are copied into the project — no opaque `node_modules` dependency. We own the code, customize freely, and delete what we don't need. Base UI provides accessible, unstyled primitives (Dialog, Dropdown, Tabs, Tooltip, etc.); Tailwind provides the utility layer; shadcn/ui wires them together with sensible defaults. Components are scaffolded via the shadcn MCP / CLI rather than hand-copied.
- **Why shadcn specifically:** LLMs (Opus, Sonnet, GPT) are heavily trained on shadcn patterns and generate fluent, idiomatic code against them. This is a direct development-velocity multiplier when coding with agents. Fighting the grain of what models know best is wasted effort.
- **Bundle discipline:** Base UI primitives are tree-shakeable (~2-4KB each, ~15-25KB for typical usage). Tailwind's JIT compiler purges unused classes (~5-10KB gzipped output). Total UI layer overhead: ~20-35KB gzipped — well within the 150KB budget.
- **System font stack** (already in place).
- **Light mode only to start.** Dark mode is straightforward with Tailwind's `dark:` variant + CSS custom properties, but deferred to avoid scope creep.
- **Minimal motion.** Transitions for panel open/close, card state changes. No gratuitous animation.
- **Polished ≠ heavy.** The goal is clean typography, clear hierarchy, good spacing, and obvious affordances — not visual flourish. shadcn's defaults are deliberately understated, which fits.

### Technology Constraints

| Dimension  | Decision                               | Rationale                                               |
| ---------- | -------------------------------------- | ------------------------------------------------------- |
| Framework  | React 18 (keep)                        | Already in use, adequate, no migration cost             |
| Build      | Vite (keep)                            | Fast, already configured                                |
| Styling    | Tailwind CSS (JIT) + CSS vars          | Purged output ~5-10KB; LLM-fluent utilities             |
| Components | shadcn/ui (Base UI primitives)         | Owned source, accessible, LLM-native patterns           |
| Routing    | wouter (history mode)                  | See ADR-0001a §1                                        |
| State      | React context + useReducer (keep)      | Already works for board; extend for chat                |
| Markdown   | `marked` (keep)                        | Already a dep; adequate                                 |
| Code       | `@uiw/react-codemirror` (CodeMirror 6) | See ADR-0001a §5 (lazy-loaded; editable + highlighting) |
| Icons      | Lucide (shadcn default) or inline SVG  | Tree-shakeable; ~200B per icon                          |
| Testing    | Vitest (keep)                          | Already configured                                      |

---

## Child ADRs

| ID        | Topic                                  | Status                 | Scope                                                                                                                                                                                          |
| --------- | -------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR-0001a | Frontend infrastructure (consolidated) | Proposed               | Routing, responsive layout, performance budget, accessibility,                                                                                                                                 |
|           |                                        |                        | code editing/syntax highlighting — absorbs former ADR-0001c/d/e/f                                                                                                                              |
|           |                                        |                        | and the routing slot                                                                                                                                                                           |
| ADR-0002  | Chat interface                         | Proposed               | 4-pane layout (sessions/files/editor+preview/chat), ACP event rendering, thinking + image upload, agent selector, thread model summary (session/permission/attachments deferred to child ADRs) |
| ADR-0001b | ~~Chat architecture~~                  | Superseded by ADR-0002 | ~~Daemon API additions, WS event extensions, streaming protocol~~                                                                                                                              |

---

## Consequences

### Positive

- **Primary interface is first-class.** Users get a polished, responsive webapp they can use on any device.
- **Chat surface unlocks new workflows.** Repo-level conversation, multi-task planning, and ad-hoc agent interaction — all without leaving the browser.
- **No new backend coupling.** The webapp remains a thin client. Daemon API is authoritative. This scales to future clients (TUI, VS Code) without duplicating logic.
- **Incremental delivery.** Board improvements, chat, and mobile layout can ship independently.

### Negative / Risks

- **Scope creep.** "Full-featured" is a moving target. The child ADR structure is the mitigation — each surface area is scoped and decided separately.
- **Chat requires daemon API work.** The repo-level chat endpoint doesn't exist yet. This ADR intentionally does not define it — that's ADR-0001b's job — but it's a dependency.
- **Performance budget is achievable but needs discipline.** React (~40KB) + Base UI primitives (~20KB) + Tailwind (~8KB) + app code leaves ~80KB for markdown, the CodeMirror engine, and chat. Code splitting and lazy loading are the escape valves.
- **No dark mode at launch.** Some users will want it immediately. Custom properties make it easy to add later, but it's explicitly deferred.

---

## Alternatives Considered

1. **Keep the webapp minimal; invest in a TUI instead.** Rejected. The webapp is the interface most users will reach for. A TUI is complementary, not a replacement. PROJECT.md §2.7 says clients are thin — but "thin" means "no backend logic," not "no UX."

2. **Hand-roll all components with vanilla CSS.** Rejected. The component count is already non-trivial (modals, dropdowns, tabs, tooltips, chat bubbles, code blocks, toasts) and will grow. Hand-rolling accessible primitives is expensive, error-prone, and fights the LLM grain — models generate shadcn/Base UI patterns fluently but produce inconsistent bespoke components. The bundle overhead (~20-35KB gzipped) is acceptable.

3. **Adopt a heavy component library (MUI, Ant Design, Chakra).** Rejected. These ship large runtime CSS-in-JS or full component bundles that blow the performance budget. shadcn/ui's copy-paste model avoids this — you only include what you use, and you own the source.

4. **Replace React with Preact or Solid for smaller bundle.** Deferred. React 18 is already here and the bundle impact (~40KB gzipped) is acceptable within the 150KB budget. If the budget proves tight, Preact is a drop-in swap worth considering.

5. **Server-side rendering.** Rejected. The daemon is a local tool, not a public website. SSR adds complexity with no SEO or cold-start benefit. The SPA loads from localhost — latency is negligible.
