# ADR-0001b: Frontend State and Data Fetching with Zustand and TanStack Query

**Status:** Accepted
**Date:** 2026-07-16
**Parent:** ADR-0001 (Daemon Webapp)
**Amends:** ADR-0001a (Frontend Infrastructure)

---

## Context

Marshal's frontend is a thin React client over a daemon-owned HTTP and WebSocket API. The daemon remains authoritative for tasks, thread transcripts, lifecycle transitions, agent execution, permissions, and all durable state. The browser initializes resources through HTTP, receives live deltas through the WebSocket bus, and keeps transient interaction state in React.

The current frontend implements shared state with one app-level `BoardProvider`, several `useReducer` projections, and mutation callbacks exposed through React context. Request/response resources are loaded with native `fetch` inside `useEffect`, with each component manually managing cancellation flags, loading state, errors, retries, and reconciliation with WebSocket events.

This was appropriate for the first board surface, but the provider now spans unrelated domains:

- task cards and task mutations;
- spec-authoring messages;
- chat threads, messages, and permissions;
- WebSocket connection status and event dispatch;
- toasts and confirmation dialogs.

The chat and detail surfaces have also accumulated repeated request lifecycle code for task detail, diffs, thread history, agents, files, permissions, archived threads, and attachments. Some calls use `web/src/api/client.ts`; others call `fetch` directly from components. Cache ownership and WebSocket reconciliation are implicit rather than documented.

The refactor must preserve the project's existing constraints:

- The daemon is the sole durable source of truth and enforces all lifecycle rules.
- The WebSocket connected snapshot plus subsequent events are the live synchronization protocol.
- Reconnect receives a fresh snapshot; the browser does not require an event replay buffer.
- The client must not duplicate the daemon's task state machine or agent/session ownership.
- Local UI state should remain local rather than moving into a global store by default.
- New runtime dependencies must justify their bundle cost under ADR-0001a's performance policy.
- Pure state and query-integration logic remains testable in the Node-based Vitest environment; this ADR does not introduce DOM testing.

## Decision

Marshal will adopt **Zustand** for shared live client projections and **TanStack Query** (`@tanstack/react-query`) for request/response server resources. Native `fetch` remains the HTTP transport behind the typed API client. The native WebSocket connection remains Marshal's live event transport.

The libraries have distinct ownership boundaries. They are not interchangeable global-state mechanisms.

### 1. State Ownership

State is assigned according to the following rules:

| State class | Owner | Examples |
| --- | --- | --- |
| Durable domain state | Daemon | tasks, task status, thread records, transcripts, permissions |
| Shared live projection | Zustand | task cards, visible thread metadata, live message deltas, active permission requests, socket status |
| Fetch-backed resource | TanStack Query | task detail, task diff, thread hydration, agents, files, archived threads, attachment metadata |
| Transient interaction state | React component | open dialogs, draft input, selected file, filters, mobile pane, in-progress form state |
| Ephemeral global UI state | Small dedicated Zustand store or existing local owner | toasts; confirmation rendering may remain component-owned |

No resource should have two independent canonical client owners. A feature must identify whether it is a live projection or a fetch-backed resource before implementation.

### 2. Zustand Stores

Replace the broad `BoardContext` state API with domain-oriented Zustand stores. The initial target split is:

```text
taskStore
  tasksById
  socketStatus
  applyTaskEvent(event)

chatStore
  threadsById
  liveMessagesByThread
  permissionsByThread
  applyChatEvent(event)

toastStore
  toasts
  push/dismiss operations
```

The exact file split may remain small while the surface is small; the architectural requirement is domain ownership and selective subscriptions, not a store per noun.

Existing pure reducers or equivalent pure event-application functions remain the authoritative transformation logic for WebSocket snapshots, deltas, and optimistic changes. Zustand stores call those functions rather than scattering event-shape switches across actions and components. This preserves deterministic unit testing and keeps the event protocol explicit.

Components subscribe through selectors to the smallest state they need:

```ts
const tasks = useTaskStore(selectTasks);
const socketStatus = useTaskStore((state) => state.socketStatus);
```

Store actions may coordinate API mutations and optimistic projection updates, but stores must not encode task-transition validity or other daemon business rules. Optimistic task updates continue to capture the previous projection, apply immediately, commit the server result, and roll back on failure.

Zustand is not used for route-local or short-lived state. Draft text, loading affordances, search input, selected panes, and modal visibility stay in components unless they must survive navigation or be shared by independent surfaces.

### 3. TanStack Query Resources

TanStack Query owns HTTP snapshot and detail lifecycles. Initial query families are:

```ts
["tasks"]
["task", slug]
["task", slug, "diff"]
["threads", { archived }]
["thread", threadId]
["thread", threadId, "files"]
["thread", threadId, "file", path]
["thread", threadId, "permissions"]
["thread", threadId, "attachments"]
["chat-agents"]
```

Query key factories should be centralized by domain so invalidation and direct cache updates do not rely on duplicated array literals.

Query functions call `web/src/api/client.ts`; components do not call `fetch` directly. The API client remains responsible for:

- same-origin `/api` URLs;
- URL encoding;
- request serialization;
- response-envelope extraction;
- converting non-success responses into `ApiError` values.

TanStack Query owns loading, error, retry, cancellation, stale, and refetch state for these resources. Query functions accept and forward an `AbortSignal` where the browser request can be cancelled. Components should not reproduce cancellation flags around query-backed resources.

Retries are conservative because Marshal is a local control plane:

- GET queries may use a small bounded retry policy for transient network failures.
- Mutations are not automatically retried unless an endpoint is explicitly idempotent and the retry is justified.
- Semantic `4xx` errors are not retried.
- Reconnect and explicit retry affordances remain visible product states.

Queries that are conditional use `enabled`; for example, a task diff is fetched only when the task is in `review`.

### 4. WebSocket Integration

The WebSocket bus remains independent of TanStack Query. One app-level connection manager opens `/ws`, reports connection status to the live store, and routes each event through a single integration point.

Events are handled according to resource ownership:

- Connected snapshots and live collection deltas update Zustand projections directly.
- Events containing complete query-resource payloads may update the matching query cache with `queryClient.setQueryData`.
- Events that imply a detail resource changed but do not contain its complete representation invalidate the narrowest matching query.
- Events must not trigger broad invalidation of all frontend queries.

Examples:

```text
connected/task.created/task.updated/task.transitioned
  -> update taskStore projection
  -> invalidate ["task", slug] only when cached detail may be stale

thread.created/thread.updated/thread.deleted
  -> update chatStore thread projection
  -> update or invalidate affected thread queries

thread.message
  -> update chatStore live message projection
  -> merge by message ID with hydrated transcript data

permission events
  -> update chatStore active permission projection
  -> invalidate permission query only when the event is insufficient to reconcile it
```

The connected snapshot is authoritative for collection projections after reconnect. Stores replace snapshot-backed collections rather than merging indefinitely with potentially stale records.

The existing rule for duplicate delivery remains: HTTP mutation responses and subsequent WebSocket broadcasts may describe the same durable entity. Reconciliation uses stable task, thread, message, attachment, or request IDs and must be idempotent.

### 5. Mutations

Use TanStack Query mutations for HTTP mutation lifecycle state. Mutation functions continue to live in `web/src/api/client.ts`; feature hooks or store actions compose them with projection and cache updates.

Mutation ownership follows the affected state:

- Task mutations optimistically update `taskStore`, then reconcile the returned task and relevant detail queries.
- Thread metadata mutations update `chatStore` and the matching thread query.
- Message sends reconcile durable returned messages immediately and tolerate duplicate WebSocket delivery by message ID.
- Permission decisions remove or reconcile the request only after the server response or matching bus event.
- Uploads update or invalidate attachment metadata without storing `File` objects globally.

Optimistic updates are used only when rollback is deterministic. Destructive or lifecycle-sensitive operations may remain pessimistic when an optimistic projection would mislead the user.

Mutation errors are exposed as `ApiError`; feature-level hooks map machine codes to product copy through `web/src/api/errors.ts`. Stores and query functions do not own presentation strings.

### 6. Provider Composition

`QueryClientProvider` is mounted once near the application root. Zustand stores require no React provider unless a future test or multi-instance requirement provides a concrete reason to use vanilla stores with context.

The target root is conceptually:

```text
QueryClientProvider
  WebSocketBridge
    AppShell
      Routes
    ToastHost
```

`WebSocketBridge` performs synchronization only and renders no product UI. Toast and confirmation rendering remain explicit UI concerns rather than responsibilities of the transport bridge.

### 7. Persistence

Do not persist Zustand stores or the TanStack Query cache to `localStorage`, IndexedDB, or another browser store as part of this refactor. Marshal is daemon-authoritative, and reconnect/fresh-load hydration is cheap and safer than restoring potentially stale lifecycle state.

Persisted drafts continue to use daemon APIs where durability is required. Browser-only persistence requires a separate decision tied to a concrete offline or restart-resilience requirement.

### 8. Bundle and Loading Policy

Zustand and TanStack Query are accepted as justified frontend runtime dependencies despite ADR-0001a's bundle budget because they replace growing application-owned synchronization and request lifecycle machinery.

The query client is shared infrastructure and may be included in the initial application chunk. Feature-specific query hooks remain in route chunks where practical. After introduction, run `pnpm run analyze` and inspect the initial chunk. If the refactor materially threatens the existing initial-JS budget, reduce duplicated app code and review import paths before weakening the budget.

Import from the libraries' public package entry points and avoid optional persistence/devtools packages in production. TanStack Query Devtools are not shipped in the production graph.

### 9. Testing

Keep event projection functions and selectors pure and test them directly. Add tests for:

- connected snapshot replacement;
- idempotent duplicate HTTP/WebSocket reconciliation;
- optimistic apply, commit, and rollback;
- query-key construction;
- narrow event-driven cache updates or invalidations;
- mutation error mapping;
- reconnect reconciliation where it can be expressed without a DOM.

Do not introduce React component tests, jsdom, happy-dom, or React Testing Library. The existing frontend testing policy remains unchanged.

## Migration Plan

The migration is incremental. Zustand and TanStack Query must not be introduced through a single rewrite of all frontend state.

### Phase 1: Normalize the API Boundary

- Move remaining component-level `fetch` calls into `web/src/api/client.ts`.
- Make error parsing consistent across all endpoints.
- Add `AbortSignal` support to GET functions used by queries.
- Define query-key factories and create the root `QueryClientProvider`.

### Phase 2: Isolated Query Resources

- Migrate task detail and task diff to TanStack Query first.
- Migrate chat agents, files, permissions, archived threads, attachments, and selected-thread hydration.
- Preserve the current WebSocket reducers during this phase.
- Remove replaced loading/error/cancellation effects as each resource migrates.

### Phase 3: Live Stores

- Move task collection projection and socket status from `BoardContext` to `taskStore`.
- Move thread metadata, live messages, and permissions to `chatStore`.
- Retain pure reducer/event functions and add selector-based subscriptions.
- Move toasts to a small dedicated store if doing so reduces the remaining provider surface.

### Phase 4: WebSocket Bridge and Mutation Reconciliation

- Replace provider-owned bus setup with `WebSocketBridge`.
- Document and implement event-to-store/query reconciliation in one module.
- Convert task, thread, message, upload, and permission actions to query mutations or domain hooks.
- Verify duplicate HTTP response and WebSocket event handling is idempotent.

### Phase 5: Remove the Broad Context

- Remove `BoardProvider` after all consumers use stores, query hooks, or focused UI owners.
- Remove obsolete reducers only where their logic has been preserved as pure event functions.
- Run bundle analysis and the full frontend check, test, and build commands.

Each phase must leave the application functional and may ship independently.

## Alternatives Considered

### 1. Keep React Context and `useReducer`

Context and reducers are sufficient in principle, and the pure reducer model is valuable. Rejected as the primary shared-state API because the provider has become a broad dependency surface, all consumers are notified through context value changes, and mutation/transport/UI concerns are increasingly coupled. The decision preserves pure reducers while replacing context as the subscription and action-distribution mechanism.

### 2. Use TanStack Query for All Server-Derived State

The task and chat collections could live entirely in the query cache, with every WebSocket event expressed through `setQueryData`. Rejected because the WebSocket bus is a first-class event stream with snapshot replacement, optimistic events, and multiple projections. Encoding all live behavior as query-cache manipulation would make the cache an event store and obscure the protocol. TanStack Query is used where its request/cache lifecycle is the natural model.

### 3. Use Zustand for All Fetching and Caching

Stores could own every loading flag, request, cache, retry, and cancellation path. Rejected because this recreates the server-state machinery TanStack Query already provides and would retain much of the current manual lifecycle code under a different API.

### 4. Adopt Redux Toolkit and RTK Query

Redux Toolkit could provide one integrated event, store, and query stack. Rejected because it imposes a larger framework and migration on a small local SPA. Zustand plus TanStack Query preserves explicit domain functions and introduces less ceremony while matching the two distinct live-event and HTTP-resource models.

### 5. Adopt SWR Instead of TanStack Query

SWR is smaller and handles common fetch caching well. Rejected because Marshal already needs explicit mutation lifecycles, conditional resources, narrow cache updates, query cancellation, and structured WebSocket integration. TanStack Query provides the more complete and idiomatic API for the expected growth.

### 6. Adopt AI SDK `useChat`

Rejected and outside the scope of this refactor. Marshal's daemon owns durable ACP-backed threads, permissions, attachments, cancellation, and multi-client WebSocket synchronization. A generic chat transport hook would not replace those semantics. Chat components may gain Marshal-specific hooks built on the stores and queries defined here.

## Consequences

### Positive

- Shared state gains selective subscriptions without a broad provider API.
- HTTP resources gain consistent caching, cancellation, retries, invalidation, and request lifecycle state.
- WebSocket projections and fetch-backed resources have documented, non-overlapping ownership.
- Existing pure event reducers remain useful and testable.
- Direct component-level `fetch` calls and repeated cancellation effects are removed.
- The daemon remains authoritative; the frontend does not acquire a competing durable state model.
- The migration can proceed feature by feature instead of requiring a frontend rewrite.

### Negative / Risks

- The frontend now has two state libraries, so ownership discipline is required to avoid duplicate canonical state.
- WebSocket-to-query reconciliation introduces explicit integration code that must stay narrow and idempotent.
- Zustand actions can become an unstructured service layer if domain boundaries and pure event functions are not preserved.
- TanStack Query defaults, especially retries and stale behavior, can be inappropriate for a local control plane if left unconfigured.
- Two new runtime dependencies consume bundle budget and must be measured with `pnpm run analyze`.
- During migration, old context state and new stores/queries may temporarily coexist; phases must avoid independent writes to the same resource.

## Non-Goals

- Changing the daemon HTTP or WebSocket protocol solely to fit either library.
- Moving task lifecycle validation into the browser.
- Persisting frontend stores or query caches.
- Replacing wouter or changing route structure.
- Adopting AI SDK `useChat`.
- Introducing generated API clients, GraphQL, tRPC, or a backend-for-frontend layer.
- Adding DOM/component tests.

## Acceptance Criteria

This ADR is implemented when:

- Zustand and TanStack Query are declared frontend dependencies and their production bundle impact has been inspected.
- No feature component calls `fetch` directly.
- `BoardProvider` no longer owns task, chat, WebSocket, mutation, and toast concerns as one context value.
- Shared task/chat projections are consumed through selective Zustand selectors.
- Fetch-backed detail resources use centralized TanStack Query keys and hooks.
- One WebSocket integration point updates stores and narrowly reconciles query caches.
- HTTP response plus WebSocket duplicate delivery is idempotent for tasks, threads, and messages.
- No browser persistence or client-side lifecycle authority has been introduced.
- `pnpm run check:all`, followed by `pnpm run test:all`, remains green.
