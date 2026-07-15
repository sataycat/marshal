# TODO — ADR-0001a Frontend Infrastructure

Tracks the 5-pass implementation of [ADR-0001a](docs/adr/ADR-0001a-frontend-infrastructure.md). Each pass is reviewable on its own and intentionally narrow so the diff stays tractable.

**Branch convention:** implement in order; do not start a later pass until the prior one is reviewed and accepted.

---

## Pass 1 — Routing foundation ✅ done

- `wouter@3.10.0` installed; `routes.ts` centralizes paths, nav items, and chunk loaders.
- `App.tsx` rewritten with `Router` + `Switch` + `lazy()` route components; `/` redirects to `/board`; `BoardProvider` at app level (shared WebSocket bus).
- `AppShell` owns the header + main slot; `PrefetchNavLink` triggers route chunk load on `mouseenter`/`focus`.
- `Board.tsx` is a surface (no header); `ToastHost` moved to `App`.
- 11 new tests for the routing helpers; `pnpm run check:all` and `pnpm run test:all` green; `vp staged` clean.
- Build: initial chunk **52.81 KB gzipped** (budget 110 KB), board chunk 16.27 KB, chat placeholders 0.25–0.31 KB.

---

## Pass 2 — Performance tooling ✅ done

**Goal:** make the 150 KB budget enforceable. Without `size-limit` in CI, the budget erodes silently.

**Steps**

1. Add `size-limit` + `@size-limit/preset-app` (dev deps in `web/`).
2. Add `rollup-plugin-visualizer` (dev dep, behind an `ANALYZE` env flag, not in the production graph).
3. In `web/vite.config.ts`:
   - Wire the visualizer when `process.env.ANALYZE === "1"` (or when running `vite build --mode analyze`).
   - Keep `manualChunks` minimal — let Vite's natural lazy split do the work; we just observe it.
4. Refactor `web/src/markdown.ts` to expose a `renderMarkdown(src)` that dynamic-imports `marked` on first call; cache the resolved module. The point is finer-grained than the route-level split: within a route, `marked` is its own sub-chunk that loads on first markdown render.
5. Add `web/.size-limit.json` (or `size-limit` field in `web/package.json`) with budgets:
   - `dist/assets/app-*.js` ≤ **110 KB gzipped** (initial chunk; React + ReactDOM + wouter + app shell + BoardContext).
   - `dist/assets/BoardRoute-*.js` ≤ **25 KB gzipped** (current ~16 KB; leaves headroom for spec-chat additions in Phase 2).
   - `dist/assets/ChatRoute-*.js` and `dist/assets/ChatThreadRoute-*.js` ≤ **5 KB gzipped** (placeholders today; will grow with chat surface).
   - `dist/assets/NotFoundRoute-*.js` ≤ **2 KB gzipped**.
   - `dist/assets/codemark-*.js` ≤ **90 KB gzipped** (deferred — added in Pass 4; budget reserved).
6. Add scripts in `web/package.json`:
   - `size`: `size-limit`
   - `analyze`: `cross-env ANALYZE=1 vite build` (also auto-runs size-limit after)
7. Add `pnpm run size` and `pnpm run analyze` to the root `package.json` (`scripts`).
8. Wire `size-limit` into `pnpm run build:web` so the build fails when a budget is exceeded.
9. Add a brief note in `AGENTS.md` under "Pre-commit hooks" that `pnpm run size` runs in CI and locally on `pnpm run build:web`.

**Files touched**

- `web/package.json` (deps + scripts)
- `web/vite.config.ts` (visualizer plugin)
- `web/src/markdown.ts` (lazy `marked`)
- `web/.size-limit.json` (new) or `web/package.json` (`size-limit` field)
- `package.json` (root scripts)
- `AGENTS.md` (note)
- New: `web/src/markdown.test.ts` — verifies `renderMarkdown` resolves to a function and produces the same output across calls (caching test).

**Acceptance**

- `pnpm run size` exits 0 with current bundle.
- `pnpm run build:web` runs size-limit and fails when a budget is artificially lowered by 1 KB.
- `pnpm run analyze` writes a `dist/stats.html` treemap and exits 0.
- `marked` chunk is its own sub-chunk within the BoardRoute load.

**Dependencies:** Pass 1 done.

---

## Pass 3 — Tailwind v4 + Base UI migration ✅ done

**Goal:** responsive layout system per ADR-0001a §2. Honest migration: plain CSS goes, Tailwind utilities take over, Base UI primitives replace hand-rolled modals.

**Steps**

1. Add `tailwindcss@4` and `@tailwindcss/vite` (dev deps in `web/`).
2. Add `@base-ui-components/react` (runtime dep) and `clsx` + `tailwind-merge` (small, for the `cn()` helper).
3. In `web/vite.config.ts`, register `@tailwindcss/vite` and add an `index.css` (or rename `styles.css`) that imports Tailwind v4.
4. In the CSS, declare an `@theme` block overriding breakpoints to the named scale: `sm = 480px` (phone), `md = 768px` (tablet). This makes `sm:`/`md:` mean what ADR-0001a intends.
5. Hand-author a tiny Base UI component set in `web/src/components/ui/`:
   - `cn.ts` — `cn(...inputs)` helper (clsx + tailwind-merge).
   - `Sheet.tsx` — Base UI `Dialog` variant for transient panels (thread list, command palette).
   - `Dialog.tsx` — wraps Base UI `Dialog` for modals (new task, confirm).
   - `Button.tsx` — small wrapper used by New Task, action bar, etc.
   - `Tooltip.tsx` — Base UI `Tooltip` (used by ws status pill and timestamps later).
   - `Tabs.tsx` — Base UI `Tabs` (used for the mobile bottom-nav and the board|chat surface switch).
6. Migrate component-by-component to Tailwind utilities, deleting the matching rules from `styles.css` as we go:
   - `AppShell.tsx` — header layout; container queries for the main slot (`@container` so the chat pane knows its own width).
   - `Board.tsx` — toolbar + columns grid; `md:grid-cols-6` desktop, `sm:grid-cols-2` tablet, stacked on phone.
   - `TaskCard.tsx`, `NewTaskModal.tsx`, `ConfirmDialog.tsx`, `ToastHost.tsx`, `TaskDetail.tsx`, `SpecChatPanel.tsx`, `DiffView.tsx` — each rewritten in Tailwind; modals get the new `Dialog`/`Sheet` primitive.
7. Replace the `<div class="modal-backdrop">` confirm dialog with the new `Dialog` component; thread-list and command-palette get `Sheet`.
8. Add a mobile bottom nav (`Tabs`/`Sheet` hybrid) visible below `md:` that toggles between Board / Chat / Detail surfaces; on `md:` and up, surfaces sit side-by-side.
9. Trim `styles.css` to design tokens only (or delete entirely; design tokens can be CSS variables in the `@theme` block).

**Files touched**

- `web/package.json` (deps + scripts)
- `web/vite.config.ts` (Tailwind plugin)
- `web/src/styles.css` (Tailwind import + `@theme`; trimmed to tokens) or replaced by `web/src/index.css`
- `web/src/shell/AppShell.tsx` (Tailwind)
- `web/src/board/Board.tsx`, `BoardContext.tsx`, `TaskCard.tsx`, `NewTaskModal.tsx`, actions/reducer (style-only)
- `web/src/detail/TaskDetail.tsx`
- `web/src/diff/DiffView.tsx`
- `web/src/specchat/SpecChatPanel.tsx`
- `web/src/components/ConfirmDialog.tsx` (rewrite on top of `Dialog`)
- `web/src/toast/ToastHost.tsx`
- New: `web/src/components/ui/cn.ts`, `Sheet.tsx`, `Dialog.tsx`, `Button.tsx`, `Tooltip.tsx`, `Tabs.tsx`

**Notes (this PR)**

- Frontend component-appearance tests removed per AGENTS.md; pure-logic tests in `web/src/**/*.test.ts` retained.
- shadcn/ui (Base UI) primitives used directly: `Button`, `Dialog`, `Sheet`, `Tabs`, `Tooltip`, `Input`, `Textarea`, `Field`, `Card`, `Separator`, `ScrollArea`.
- `web/src/styles.css` replaced by `web/src/index.css` (Tailwind v4 + `@theme` tokens).
- New mobile bottom-nav (`Tabs` at `md:hidden`).

**Acceptance**

- `styles.css` is reduced to a `tokens.css` (or removed) and Tailwind utilities do the layout work.
- At `md:` (768px) the board + detail sit side-by-side; below `md:` they stack and the bottom nav appears.
- The new `Dialog` is used by `NewTaskModal` and `ConfirmDialog`; Escape and focus trap work without us authoring them.
- Lighthouse Performance ≥90 / Best Practices ≥95 in a local `pnpm run build:web && lhci` run; numbers recorded in the PR.
- `pnpm run size` still green; bundle delta < 30 KB gzipped for Tailwind+Base UI typical usage.
- All existing tests pass.

**Dependencies:** Pass 2 done (size-limit so we catch a Tailwind regression immediately).

---

## Pass 4 — CodeMirror integration

**Goal:** one engine (`@uiw/react-codemirror`) for both read-only highlighting and editable code; lazy chunk with its own budget.

**Steps**

1. Add `web/` deps: `@uiw/react-codemirror`, `@codemirror/state`, `@codemirror/view`, `@codemirror/language`, `@codemirror/lang-javascript` (covers TS/JS/TSX/JSX), `@codemirror/lang-markdown`, `@codemirror/lang-json`, `@codemirror/lang-css`, `@codemirror/lang-python`, `@codemirror/legacy-modes` (covers `python` and `sql` stream modes, plus `diff` for the hunk body). Trim the language set if the chunk exceeds the 90 KB ceiling; drop SQL or Python first, then CSS — keep TS/MD/JSON.
2. New file `web/src/codemirror/CodeBlock.tsx` — the public surface. `editable: boolean` prop. Internally lazy-imports `@uiw/react-codemirror` and the per-language extensions on first mount; resolves the same module on subsequent mounts in the session.
3. New file `web/src/codemirror/languages.ts` — maps fence language strings (`ts`, `typescript`, `tsx`, `js`, `javascript`, `jsx`, `md`, `markdown`, `json`, `jsonc`, `css`, `py`, `python`, `sql`, `diff`, `patch`) to the corresponding extension import. Falls back to plain text for unknown languages.
4. New file `web/src/codemirror/MarkdownWithCode.tsx` — the integration glue. Calls `marked.parse()` for prose, then post-processes the HTML string to replace `<pre><code class="language-…">` with `<div data-cm data-lang="…" data-idx="…">…</div>` stubs. On mount, hydrates each stub with a `<CodeBlock>`. The hydration pass uses `useEffect` + a ref-collecting loop so it survives re-renders.
5. Update `web/src/markdown.ts`: add a `renderProse(src)` that returns the marked-prose HTML **with stubs** for the new `MarkdownWithCode` component. Keep the existing `renderMarkdown` for callers that don't need hydration.
6. Wire `MarkdownWithCode` into:
   - `TaskDetail.tsx` — the spec (`<MarkdownWithCode src={detail.spec_markdown} editable={false} />`). Add an "Edit this block" affordance on hover that flips a specific block to `editable` (local UI state, sends no PATCH).
   - `SpecChatPanel.tsx` — each spec-chat message.
   - `DiffView.tsx` — replace the current plain `<pre>` per hunk with a `<CodeBlock editable={false} lang="diff" />` rendering the hunk body. Keeps the file-level view; adds token-level color via CodeMirror decorations.
7. Theme: a single light theme matching the existing `--bg`/`--panel` palette, applied as a `@codemirror/view` `EditorView.theme` extension. No separate theme CSS file.
8. Remove the legacy `web/src/components/Markdown.tsx` (the old `renderMarkdown` consumer); its callers move to `MarkdownWithCode`.

> Per AGENTS.md, no component-render tests for `CodeBlock` / `MarkdownWithCode`. The hydration/state machinery is exercised manually via the human-testing guide and the daemon end-to-end flow.

**Files touched**

- `web/package.json` (deps)
- `web/src/codemirror/CodeBlock.tsx` (new)
- `web/src/codemirror/languages.ts` (new)
- `web/src/codemirror/MarkdownWithCode.tsx` (new)
- `web/src/markdown.ts` (add `renderProse`)
- `web/src/detail/TaskDetail.tsx`
- `web/src/specchat/SpecChatPanel.tsx`
- `web/src/diff/DiffView.tsx`
- `web/src/components/Markdown.tsx` (deleted)
- Update `web/.size-limit.json` with the CodeMirror chunk budget once we know its hashed name.

**Acceptance**

- Spec, chat messages, and diff hunks render code via CodeMirror with syntax highlighting; first block of a session may briefly show plain monospace, then upgrades.
- The CodeMirror chunk ships in its own file (verify in `dist/assets/`).
- Chunk size ≤ **90 KB gzipped** (`pnpm run size`); if over, trim the language set and re-measure.
- "Edit" affordance on a chat block flips it to editable; change is local (no PATCH in Phase 1 — a future ADR can wire it to `POST .../spec`).
- All existing tests pass.

**Dependencies:** Pass 3 done.

---

## Pass 5 — Polish & docs

**Goal:** confirm the chunk budgets, update human-facing docs, ship.

**Steps**

1. Run `pnpm run analyze`; review the treemap for any surprise heavy imports. Record the actual CodeMirror chunk size and update `web/.size-limit.json` to the confirmed figure.
2. If the CodeMirror chunk is over 90 KB, trim the language set (drop SQL/Python/CSS in that order) until it fits, and document the trade-off in a code comment in `languages.ts`.
3. If the initial chunk is over 110 KB, audit the imports in `App.tsx` and `shell/AppShell.tsx` for accidental pulls; defer non-critical components to a sub-chunk.
4. Run `pnpm run check:all` and `pnpm run test:all`; both must be green.
5. Update `docs/ARCHITECTURE.md` §10 (Frontend):
   - Stack: React 18 + Vite + Tailwind v4 + shadcn/Base UI + wouter + `@uiw/react-codemirror` + `marked`.
   - Routing: history mode, wouter, per-route lazy chunks; daemon SPA fallback serves deep links.
   - Layout: `<AppShell>` (header + main); `md:` breakpoint gates grid vs. stacked with bottom nav.
   - Performance: `size-limit` per-PR; Lighthouse on release tags.
   - A11y: inherited from Base UI; not tracked.
6. Update `AGENTS.md`:
   - New scripts (`pnpm run size`, `pnpm run analyze`).
   - Note that `pnpm run build:web` runs `size-limit`; if a budget is exceeded, the build fails — fix the import or update the budget with rationale.
7. Sweep `web/src/` for any leftover plain-CSS classes or stale `.css` references from the Tailwind migration.
8. Manual smoke (per `docs/HUMAN-TESTING-GUIDE.md` if it exists, otherwise: open `/`, `/board`, `/chat`, deep-link refresh each, open a code block in a real spec, resize across the 480/768 breakpoints).

**Files touched**

- `docs/ARCHITECTURE.md`
- `AGENTS.md`
- `web/.size-limit.json` (budgets tuned to actuals)
- `web/src/codemirror/languages.ts` (comment if trimmed)

**Acceptance**

- All budgets in `size-limit` are at-or-below the actuals with a small buffer.
- `pnpm run check:all`, `pnpm run test:all`, `pnpm run size` all green.
- `docs/ARCHITECTURE.md` §10 reflects the shipped stack and the size-limit/Lighthouse split.
- `AGENTS.md` lists the new commands and what they do.

**Dependencies:** Passes 1–4 done.

---

## Cross-pass risks

- **Pass 3 + Pass 4 both add weight to the initial chunk if we aren't careful.** The `BoardContext` (which holds the WebSocket) is in the initial chunk today; nothing in Pass 3/4 should pull it into a route chunk instead. If a refactor accidentally moves it, the budget check in Pass 2 catches it.
- **Base UI version churn.** `@base-ui-components/react` is still pre-1.0; pin a major and document the upgrade path. Worst case, swapping primitives is a small localized change because they're behind our hand-authored wrappers.
- **CodeMirror bundle variance.** The 90 KB ceiling is an estimate. The 60–80 KB figure in the ADR is the core + a working language set; with the full curated set it may trend higher. The acceptance criterion in Pass 4 forces an honest measurement and a trim if needed.
- **Container queries need a real chat-pane container to be meaningful.** Pass 3 sets up `@container` plumbing; Pass 4's `MarkdownWithCode` and the future chat surface will be the first real consumers. Until the chat surface ships, the container queries are wired but inert.

## Open questions (carried from the ADR)

1. **Thread-switcher keyboard model** (Cmd/Ctrl+K). ADR-0002 gestures at it. The Pass 3 `Sheet` + future `cmdk` is the plan; the small `cmdk` decision (~5 KB) is its own micro-decision and is deferred until the chat surface lands.
2. **PWA / offline resilience.** Explicitly deferred by the ADR; out of scope for this engagement.
3. **A11y regression monitoring.** Dropped per the ADR; revisit only if accessibility becomes a real requirement.

## Out of scope (for this engagement)

- Implementing ADR-0002 (chat thread model). Passes 1–5 set up the infrastructure; the chat surface is a follow-on.
- Dark mode. ADR-0001 defers it; we keep the seam (CSS variables + Tailwind tokens) so it's cheap later.
- Server-side rendering, prerender, image optimization. ADR-0001 ruled these out.
- Migrating the daemonside `SpecChatClosedError` to a chat-thread concept. That's ADR-0002 work.
