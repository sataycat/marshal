# ADR-0001a: Frontend Infrastructure — Routing, Layout, Performance, Accessibility, Code Editing & Syntax Highlighting

**Status:** Accepted
**Date:** 2026-07-15
**Parent:** ADR-0001 (Daemon Webapp)
**Children:** —

> Consolidates the four small, cross-cutting frontend-infrastructure topics that ADR-0001 originally deferred to lettered children (ADR-0001c responsive layout, ADR-0001d performance budget, ADR-0001e accessibility, ADR-0001f syntax highlighting) plus the routing decision (formerly ADR-0001a's slot). Each is a single-issue decision sharing the same context — the React 18 + Vite + Tailwind v4 + shadcn/Base UI stack chosen in ADR-0001 — and the same hard constraint: the <150KB gzipped-JS budget. Filing them together avoids five near-empty ADRs that re-state the same constraints. This revision replaces the previously-chosen Radix primitive layer with Base UI, drops the accessibility gate, and replaces the read-only `highlight.js` engine with an editable CodeMirror surface.

---

## Shared Context

ADR-0001 fixed the stack: React 18, Vite, Tailwind CSS v4 (JIT), shadcn/ui (Base UI primitives), `marked` for markdown prose rendering, light-mode only, <150KB gzipped JS, Lighthouse targets P≥90 / BP≥95 (accessibility is no longer a gated Lighthouse target — see §4). React + ReactDOM + Base UI + Tailwind consume roughly 75–85KB gzipped, leaving ~65–75KB for `marked`, the CodeMirror code engine, routing, app code, and any chat-specific logic. Every decision below is made against that remaining headroom.

The daemon already serves an SPA fallback — any non-`/api/*`, non-`/assets/*` path returns `index.html` (`src/daemon/http.ts:193`, `spaNotFound`). This means **history-based routing works for deep links** out of the box: refreshing `/chat/<threadId>` serves `index.html`, the bundle boots, and the client router resolves the route. No daemon changes are required to support either history or hash routing.

---

## 1. Client-Side Routing

### Context

Phase 1 is chat-only; Phase 2 adds a board surface and task-scoped threads. Routes needed now and soon:

| Route             | Phase | Surface                              |
| ----------------- | ----- | ------------------------------------ |
| `/`               | 1     | Redirect to `/chat` (or last thread) |
| `/chat`           | 1     | Thread list + chat pane (new thread) |
| `/chat/:threadId` | 1     | Specific thread (deep-linkable)      |
| `/board`          | 2     | Kanban (deferred)                    |
| `/board/:slug`    | 2     | Task detail (deferred)               |

ADR-0002 defines threads as the canonical chat unit, each with a stable UUID, so deep links to `/chat/:threadId` are natural and shareable.

### Decision

**wouter** (≈1.5KB gzipped) for client-side routing.

- History-mode routing (not hash). Relies on the existing daemon SPA fallback for deep-link refreshes.
- Dynamic `import()` per route so `/board` (Phase 2) ships in its own chunk and does not bloat the Phase 1 initial bundle.
- `Link` / `Route` / `useParams` / `useLocation` only — wouter exports a small, React-Router-shaped API that LLMs generate fluently.
- `<Link>` prefetches the target route's chunk on `onMouseEnter`/focus so navigation feels instant without eager loading.

### Alternatives Considered

1. **React Router v7.** Most LLM-fluent and feature-complete, but `react-router-dom` is ≈18–22KB gzipped — eats a quarter of the remaining budget for a small route table. Rejected for this app's size; revisit if nested routes/matchers grow beyond what wouter handles ergonomically.

2. **Hash-based routing (`#/chat/:id`).** Needs no server fallback and survives static hosting. Rejected — the daemon already provides SPA fallback, hash URLs are uglier and harder to share, and history mode gives cleaner deep links.

3. **Hand-rolled `useState` + `window.location`.** Tempting at this route count, but loses declarative `<Link>`, param matching, and code-splitting ergonomics. wouter costs 1.5KB to not reinvent this.

4. **TanStack Router.** Type-safe, file-based routing; still pre-v1, so API churn risk and a moving target to generate code against. Heavier than wouter and its ergonomics target larger apps. Overkill for a three-route SPA; revisit only if the route table grows past what wouter models ergonomically.

5. **TanStack Start.** The broader TanStack framework layers SSR, server functions, and a full-stack app model on top of the router. Wrong shape entirely for a local-first thin client that talks to the daemon API — it solves problems (server rendering, deployment adapters, server RPC) this app does not have. Rejected outright, not as "heavier" but as a different category.

---

## 2. Responsive Layout System

### Context

ADR-0001 fixed breakpoints (~768px tablet, ~480px phone) and a target IA: on desktop the board/chat and a detail/chat panel sit side-by-side; tablet stacks; mobile shows one surface with bottom nav (Board | Chat | Detail). The existing frontend was desktop-only and board-only.

### Decision

**Tailwind responsive utilities + a single thin `<AppShell>` + shadcn components (Base UI) for mobile/transient panels.** No separate responsive-layout framework. Concrete pieces (`Sheet`, `Dialog`, `Tooltip`, etc.) are scaffolded from the shadcn registry via the shadcn MCP/CLI rather than hand-authored — we ship owned source, but don't write the primitives ourselves.

- **Breakpoints as Tailwind tokens.** Override Tailwind's default scale to match ADR-0001's named breakpoints so `sm:`/`md:` map to the 480px/768px gates by intent rather than by Tailwind's arbitrary defaults. Encoded in `@theme` under Tailwind v4 so the named breakpoints are not magic numbers scattered through markup.
- **`<AppShell>` with named slots** (`header`, `sidebar`, `main`, `statusbar`). One component owns the grid/fl layout; surfaces fill slots. At `md:` and below it collapses to a single visible slot driven by bottom-nav state.
- **Bottom nav on mobile** is a small custom component (three buttons); selecting one swaps the active slot. No tab library — Base UI `Tabs` is desktop-oriented and the mobile pattern is intentionally simpler.
- **`Sheet` (Base UI Dialog variant)** for transient panels on mobile (thread list, task detail) and for any `Cmd+K`-style thread switcher ADR-0002 gestures at. Base UI handles focus trap, Escape, and scroll lock; we supply the layout.
- **Container queries for component-scoped layout.** Tailwind v4 ships container queries natively, so use `@container` for cases where viewport width is the wrong signal — e.g., the chat pane width when it's docked beside the board vs. fullscreen. Container queries let the same component adapt to its allocated width, not the window's. Reserved for genuinely container-relative behavior; the default remains viewport breakpoints.
- **No CSS-in-JS, no `styled-components`.** Tailwind utilities + a small `styles.css` of custom properties (panel radius, gutter, motion durations) as ADR-0001 already mandated.

### Alternatives Considered

1. **A layout-primitive library (`react-resizable-panels`, `react-aria` layout).** Adds weight and its own opinions. The layout here is a fixed two-pane → single-pane collapse, which a 60-line `<AppShell>` expresses directly.

2. **Pure viewport breakpoints, no container queries.** Workable, but the chat pane legitimately has different density docked-50% vs. fullscreen, and viewport alone can't tell those apart. Container queries are native and free under Tailwind v4.

3. **Drag-to-resize split panes.** Deferred — desirable polish but not needed for Phase 1; can be layered onto `<AppShell>` later without an ADR if a small library is justified then.

---

## 3. Performance Budget and Metrics

### Context

ADR-0001 set the targets (Lighthouse P≥90 / BP≥95; <150KB gzipped JS; accessibility is no longer gated — see §4) but not how to track them.

### Decision

**Code-split aggressively; inspect bundle composition on demand; audit Lighthouse on a release cadence, not per-PR.**

- **Route-level splitting.** Each route is a lazy component (`lazy(() => import('./chat/ChatRoute'))`) loaded via wouter's `Route`. The board route (Phase 2) never loads in Phase 1 sessions.
- **Point-of-use lazy loading for the two heaviest non-core deps:**
  - `marked` — imported only by the chat and diff routes; the board route doesn't need markdown. Wrapped in a `lazyMarkdown` helper that dynamic-imports `marked` on first render of a message/diff.
  - CodeMirror code engine (see §5) — `@uiw/react-codemirror` plus its Lezer grammar packages are the single heaviest lazy dep (~60–80KB gzipped for core + a working language set, estimated). Loaded on first code-block mount, never in the initial chunk; cached for the session after.
- **`rollup-plugin-visualizer`** as a `--analyze` build flag (not a dep in the production graph) for manual triage when a chunk surprises us.
- **Lighthouse via ` @lhci/cli`** (or `unlighthouse`) run on a **release-tag / nightly** cadence against the built bundle served by the daemon. Targets are a release gate, not a per-PR block — Lighthouse is too slow and variance-prone to gate every PR.
- **No images.** System font stack already in place. Icons are inline SVG / Lucide tree-shaken to the icons used (≈200B each), imported per-icon, not via a barrel.
- **No SSR, no prerender.** ADR-0001 §5 already settled this; reaffirmed here because it bounds the perf surface to client-only.

### Alternatives Considered

1. **Automated bundle-size gates.** Removed because the extra compression pass pushed the web build past short execution timeouts. Use the visualizer when bundle composition needs investigation.

2. **Lighthouse on every PR.** Rejected — multi-minute runtime, variance on a local daemon, and it gates on metrics (TTI, CLS) that bundle-size doesn't fully control. Release cadence with manual review is the right granularity.

3. **Eager-load everything for instant nav.** Defeats the budget. Route + point-of-use splitting keeps the initial load small; prefetch-on-hover closes the perceived-latency gap.

---

## 4. Accessibility

### Context

Accessibility is **not a first-class constraint** for this tool. ADR-0001 originally set a Lighthouse a11y ≥95 target; this revision drops that target and the associated gate. The shadcn components we use sit on Base UI, which already provides accessible primitives (ARIA roles, focus handling, keyboard activation, focus traps for Dialog/Sheet, scroll lock) out of the box. For a local-first developer tool used mainly by a single author on their own machine, that inherited baseline is sufficient. No bespoke app-layer a11y work is planned.

### Decision

**Inherit a11y from the Base UI primitive layer; add nothing bespoke. No a11y gate, no a11y tracking.**

- **Use shadcn/Base UI components as-is.** Whatever ARIA roles, focus management, and keyboard behavior Base UI gives us is what ships. We do not author additional `aria-*` attributes, live regions, skip links, or a documented keyboard map.
- **No a11y test gate.** No `@axe-core` in the test suite, no Lighthouse Accessibility target. Lighthouse (§3) still tracks Performance and Best Practices as a release gate; accessibility is dropped from the Lighthouse scorecard entirely.
- **No `prefers-reduced-motion` override.** If Base UI / shadcn components honor reduced-motion on their own, good; we do not author a custom `@media` block for it.
- **No manual color-contrast verification.** Theme tokens come from the shadcn palette; we assume they are reasonable and do not audit them against WCAG AA.
- **The only "a11y" effort** is choosing the right shadcn component for the job (a real `Dialog` for modals, not a `div`), so the primitive's built-in behavior applies. That is a component-selection habit, not an a11y program.

### Alternatives Considered

1. **Keep the previous app-layer a11y program** (skip link, route-focus hook, streaming live regions, keyboard map, `prefers-reduced-motion`, axe-core gate, Lighthouse ≥95). Rejected as disproportionate for a single-user local tool; the cost (custom hooks, ongoing test maintenance, slower PRs from axe gates) is not justified by the user base, and Base UI already handles the cases that matter most (focus trap, Escape, role correctness).

2. **Adopt `react-aria` on top of Base UI for extra a11y.** Rejected — doubles opinion and weight for no realized benefit given the deprioritized a11y posture.

3. **Keep a soft Lighthouse a11y release gate (no ≥95 floor, just "don't regress badly").** Rejected — a gate without a threshold is noise; if a11y isn't tracked it shouldn't gate. Leave it out entirely to keep the release gate meaningful (Performance, Best Practices).

---

## 5. Code Editing & Syntax Highlighting

### Context

Code blocks appear in three surfaces: chat messages (mostly read-only), spec authoring (editable), and diffs (read-only with optional inline edit). ADR-0001 deferred library choice to a child ADR and flagged it as "needed for chat code blocks." The original choice (`highlight.js`) only solved rendering; in practice the author also needs to drop into editing the markdown/code directly sometimes — e.g., fixing a spec snippet or tweaking a code block before sending. That argues for one engine that does **both** highlighting and editing, rather than a read-only highlighter plus a separate editor pulled in later. The engine is the single biggest non-core dependency risk to the 150KB budget, so it is lazy-loaded and never in the initial chunk.

### Decision

**`@uiw/react-codemirror` (CodeMirror 6) as the single code surface — read-only for chat/diff code blocks, editable for spec/code authoring — lazy-loaded on first code-block render.**

- **One engine, two modes.** A `<CodeBlock>` component wraps `@uiw/react-codemirror`. In chat and diff surfaces it mounts `editable={false}` (read-only, syntax-highlighted); in spec-authoring and any "edit this snippet" affordance it mounts `editable={true}`. Same component, same highlighting path, same lazy chunk.
- **Curated Lezer language packages only.** Import per-language (`@codemirror/lang-typescript`, `@codemirror/lang-markdown`, `@codemirror/lang-json`, `@codemirror/lang-css`, `@codemirror/lang-python`, `@codemirror/lang-sql`, etc.), never a barrel that pulls every grammar. Each lang package is a few KB; the CodeMirror core plus the initial working set lands around ~60–80KB gzipped (estimate — confirm with the visualizer post-build). Trim the set if the dedicated chunk exceeds its budget (§3).
- **Lazy-load the whole engine.** `<CodeBlock>` dynamic-`import()`s `@uiw/react-codemirror` + the language set on first mount; the initial chunk never pays for it. The first code block of a session renders as plain monospace (which `marked` already produces for prose context) and hydrates into a CodeMirror instance once the chunk resolves; subsequent blocks are instant and cached for the session.
- **`marked` renders prose, not code.** `marked` still owns markdown → HTML for the prose around code blocks. A custom `marked` renderer for `code` fences emits a lightweight stub (e.g., `<div data-cm ... />`) rather than a highlighted `<pre><code>`. A thin hydration pass mounts `<CodeBlock>` onto the stubs after `marked` renders. One integration point, three surfaces — chat, spec, and diff all route fences through the same path.
- **Single light theme.** CodeMirror theme (`oneDark` is the popular default, but we ship a light theme to match ADR-0001's light-mode-only stance) applied via the `@uiw/react-codemirror` theme prop — no separate theme CSS file, no flash of unstyled code beyond the brief first-block hydration. Dark mode (deferred) swaps the theme prop later.
- **Diff highlighting** via the `@codemirror/lang-markdown` diff-lens or a small diff decoration on top of the read-only editor — same engine, no separate diff-view library at this layer. The file-level diff _view_ (hunk collapse, expansion) is a separate component layered above; token-level +/- color comes from CodeMirror decorations.
- **Editing is opt-in per surface.** Chat code blocks default to read-only (no gutter, no cursor) so chat stays a transcript; an explicit "Edit" affordance flips a block to editable when the author needs to fix a snippet inline. This keeps the common case (reading chat) undisturbed while leaving the door open to the editing workflow that motivated the pivot.

### Alternatives Considered

1. **Keep `highlight.js` for read-only chat/diff; add CodeMirror only for spec editing.** Two code/highlighting systems, two lazy chunks, two integration paths. More moving parts for the same outcome, and chat's code blocks lose the "flip to edit" affordance entirely. Rejected — one engine is simpler and the affordance is the point.

2. **Shiki / Shikiji (read-only) + CodeMirror (editor).** Shiki's WASM (~150KB) blows the budget on its own and still leaves us needing CodeMirror for editing. Doubles weight. Rejected.

3. **Prism (read-only) + a textarea-based editor.** Prism for highlighting, a plain `<textarea>` for editing — lighter, but no syntax highlighting while editing and two rendering code paths. Loses the WYSIWYG-edit benefit. Rejected for the small extra bundle cost of just using CodeMirror for both.

4. **Server-side highlighting/editing via the daemon.** Rejected — thin-client tenet (ADR-0001, PROJECT.md). Editing and highlighting are presentation; they belong in the client and stay out of the daemon's API surface.

---

## Consequences

### Positive

- **One ADR, one review.** Five cross-cutting-but-related decisions land together, consistent with each other and with the budget.
- **Heavy dependencies remain isolated.** Route splitting and point-of-use lazy loading keep `marked` and CodeMirror out of the initial chunk.
- **Routing deep-links for free.** wouter + the existing daemon SPA fallback give shareable `/chat/:threadId` links with no server changes — which ADR-0002's thread model benefits from directly.
- **A11y cost is near zero.** Inherited from Base UI; no bespoke hooks or axe gate to maintain. Acceptable for a single-user local tool and one less thing to break in CI.
- **Code editing is a first-class affordance, not an afterthought.** CodeMirror as the single engine means the author can drop into editing markdown/code directly wherever it appears; highlighting and editing share one path and one lazy chunk.

### Negative / Risks

- **wouter is less known to some LLMs than React Router.** Mitigation: its API is a React-Router subset, so models map naturally; a tiny `routes.ts` establishes the route shape as a reference. If wouter friction shows up in practice, React Router is the documented escalation (§1 alt 1) at a known ~20KB cost.
- **Bundle size is not automatically gated.** A dependency regression can land unnoticed until manual analysis or Lighthouse catches it. Mitigation: run the visualizer when adding a non-trivial frontend dependency.
- **CodeMirror is heavier than the old `highlight.js` curated set.** The dedicated chunk is ~3–4× the size of the previous ~20–25KB highlighter set. Acceptable because it is lazy and isolated in its own chunk with its own budget (§3); but a chat-heavy session with many read-only blocks pays the full chunk on the first block. Mitigation: chunk is cached for the session; no per-block re-cost.
- **A11y is deprioritized.** Dropping the gate and the bespoke app-layer work means a real regression in keyboard/focus behavior could land unnoticed. Accepted: the user base is a single local author; Base UI's defaults cover the common cases; revisit if accessibility becomes a real requirement.
- **First-paint hydration flash** on the first code block of a session (plain monospace → full CodeMirror). Acceptable and brief; cached for the session after.

---

## Open Questions

1. **Thread-switcher keyboard model.** ADR-0002 gestures at a Cmd/Ctrl+K thread switcher. This ADR assumes it's a Base UI `Dialog` with arrow+Enter; if ADR-0002 wants a richer fuzzy-match UX, a small `cmdk` (Vercel's command palette, ~5KB) may be justified — note this contradicts the "no tab library" lean in §2's bottom-nav discussion and is its own small decision.
2. **PWA / installability.** A daemon-served local tool arguably doesn't need a service worker, but if offline-resilience of the loaded bundle matters (e.g., daemon restarts mid-session), a tiny SW caching `web/dist` could help. Not needed for Phase 1; deferred.
3. **CodeMirror chunk size.** The ~60–80KB dedicated-chunk estimate and the working language set need confirming with `rollup-plugin-visualizer` once `@uiw/react-codemirror` + the chosen `@codemirror/lang-*` packages are installed. Right-size the language set before locking §3's per-chunk budgets.
4. ~~**Container-query Tailwind version.**~~ Resolved: Tailwind v4 is the baseline (shadcn registry / MCP targets v4); container queries are native, no v3 plugin needed.
