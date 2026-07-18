# Human Testing Guide

This guide is a practical, end-to-end manual test plan for Marshal across all implemented surfaces:

- CLI onboarding and daily operations
- Daemon HTTP + WebSocket API
- Web board + spec authoring chat + review/merge
- Reliability and edge conditions

It is written for local-first testing on one machine.

## 1. Test scope and assumptions

### In scope (implemented)

- `marshal init` / `marshal doctor`
- task lifecycle (`backlog -> ready -> building -> validating -> review -> done`)
- escape hatches (`building -> ready`, `building -> backlog`, `validating -> backlog`, `review -> backlog`)
- run history APIs
- spec authoring chat (`/spec-messages`, `/spec`)
- diff review and local merge (`/diff`, `/merge`)
- SPA static serving and WebSocket live updates
- Chat-first Phase 1 workbench: threads, drafts, files, permissions, images, reconnects, and mobile navigation
- Browser-first repository registration: register, select, switch, and remove local git repositories without deleting checkouts
- Browser-first ACP Registry catalog: cached public metadata, search, refresh, and stale-cache recovery
- Pinned `npx` agent installation: explicit RCE confirmation, durable progress, retry, and removal
- ACP readiness probing: temporary session validation, authentication-required state, negotiated capabilities, and actionable probe failures

### Out of scope (not current product behavior)

- multi-user auth/RBAC
- exposed non-localhost daemon as a supported default
- GitHub PR creation flow as a required path for daily operation

## 2. Environment setup

### Prerequisites

1. Node.js >= 18
2. git
3. pnpm (recommended; missing pnpm is warning-level in onboarding)
4. Network access to the public ACP Registry for the catalog refresh test

### Build

```sh
pnpm install
pnpm run build:all
```

## 3.5 Registry catalog

Open **Agents** in the web application.

Expected:

- The public catalog lists agent ID, name, version, description, source, license, links, and distribution kinds.
- Searching matches ID, name, and description without another network request.
- Registry launch arguments are not shown as editable product configuration.
- Clicking **Refresh catalog** shows a durable refreshing state. Refreshing the browser during the request does not lose that state.

To test stale recovery, temporarily block access to `cdn.agentclientprotocol.com` and refresh again.

Expected:

- The previous valid catalog remains visible.
- A stale warning identifies the failed refresh and its error.
- Restoring network access and refreshing replaces the snapshot only after the response validates.

### Test repo bootstrap

Use a throwaway git repo for manual runs:

```sh
mkdir -p /tmp/marshal-manual && cd /tmp/marshal-manual
git init -b main
git config user.email "you@example.com"
git config user.name "You"
echo "# Manual Marshal Repo" > README.md
git add README.md
git commit -m "init"
```

### 3.6 Agent readiness

After installing an agent from **Agents**, select **Probe readiness**.

Expected:

- Marshal starts only the persisted, version-pinned installation launch specification.
- A conformant no-auth agent becomes **Ready** and shows its ACP protocol version and negotiated capabilities.
- An agent advertising authentication methods becomes **Authentication required**, not ready.
- Startup, protocol, session creation, and process-exit failures remain visible as probe diagnostics.
- The temporary probe session and process are closed or terminated before the request completes.

Refresh the browser after probing and reopen **Agents**. The readiness state, failure message, protocol version, and capability snapshot must remain available.

## 3. Onboarding tests (CLI surface)

### 3.1 Happy path: first-time init

```sh
marshal init
```

Expected:

- machine preflight output printed
- repo initialized
- `.marshal/state.db` exists
- `~/.marshal/config.json` exists or is updated (interactive path)

### 3.2 Fast path: already configured machine

Run `marshal init` again in the same repo.

Expected:

- output indicates machine already configured
- repo init still succeeds

### 3.3 Doctor: read-only diagnostics

```sh
marshal doctor
```

Expected:

- no repo mutation
- clear pass/warn/fail lines
- useful remediation hints when checks fail

### 3.4 Negative onboarding checks

1. Replace one structured role with a legacy string ID, then run `marshal doctor`
2. unset provider API keys, run `marshal doctor`
3. if possible, run with older Node major (<18)

Expected:

- a string role ID is a **fail** with a structured-command migration hint
- missing auth env is **warning**
- old Node major is **fail**

## 4. Core lifecycle tests (CLI + daemon loop)

### 4.1 Create task in backlog

```sh
marshal task create --slug manual-smoke --title "Manual smoke" --spec "## Goal\nDo thing\n"
marshal task show manual-smoke
```

Expected: task exists in `backlog`.

### 4.2 Freeze spec to ready

```sh
marshal task ready manual-smoke
marshal task show manual-smoke
```

Expected:

- status becomes `ready`
- worktree and task branch created
- frozen spec file committed under `specs/`

### 4.3 Build + validate loop

```sh
marshal start
```

In another shell, monitor the task:

```sh
marshal task show manual-smoke
```

Expected:

- builder cycle: `ready -> building -> validating` path (or `building` on build error)
- validator cycle: routes to `review` on pass or back to `building` on fail

### 4.4 Retry and escalation behavior

Force validator failures (using your harness prompts/config).

Expected:

- failures increment retry count
- task bounces to `building` until retry cap
- after cap, task escalates to `review` with `last_failure`

### 4.5 Escape hatches

Exercise:

```sh
marshal task transition manual-smoke ready
marshal task transition manual-smoke building
marshal task transition manual-smoke backlog
```

Also test `validating -> backlog` from a validating task.

Expected:

- transition succeeds only for valid edges
- retry state resets on escape-hatch transitions

## 5. HTTP API tests (contract-level)

Start daemon:

```sh
marshal start --interval 5000
```

In another shell, discover port:

```sh
cat .marshal/daemon.port
```

Assume `PORT=$(cat .marshal/daemon.port)`.

### 5.1 Health and basic routes

```sh
curl -s http://127.0.0.1:$PORT/api/health
```

Expected: `{"status":"ok","version":"..."}`.

### 5.2 Task CRUD and validation

1. `POST /api/tasks` valid payload
2. `GET /api/tasks`
3. `GET /api/tasks/:slug`
4. `POST /api/tasks/:slug/transition`
5. `POST /api/tasks/:slug/ready`

Negative checks:

- malformed JSON => `400 invalid_json`
- unknown body field => `400 unknown_field`
- missing required field => `422 missing_field`
- unknown status => `422 unknown_status`
- invalid transition => `409 invalid_transition`

### 5.3 Runs APIs

Test:

- `GET /api/tasks/:slug/runs`
- `GET /api/runs/:id`
- `GET /api/runs/:id/events?limit=...&after_seq=...`

Negative checks:

- non-numeric run id => `400 invalid_run_id`
- unknown run => `404 run_not_found`
- `limit > 500` => `422 invalid_limit`
- malformed `after_seq` => `400 invalid_query`

### 5.4 Spec APIs

Backlog task:

- `GET /api/tasks/:slug/spec-messages`
- `POST /api/tasks/:slug/spec-messages` with user content
- `POST /api/tasks/:slug/spec` with `spec_markdown`

Negative checks:

- empty content/spec => `422 invalid_field`
- unknown fields => `400 unknown_field`
- non-backlog task => `409 spec_chat_closed`

### 5.5 Diff and merge APIs

Review task:

- `GET /api/tasks/:slug/diff`
- `POST /api/tasks/:slug/merge`

Negative checks:

- task not in review => `409 not_review`
- merge conflict => `409 merge_conflict`, task remains `review`

### 5.6 Remote password access

Start a deliberately exposed daemon with a password supplied outside the process arguments:

```sh
MARSHAL_UI_PASSWORD='use-a-long-random-password' marshal start --lan --port 7433
```

Expected:

- startup fails if `--lan` or a non-loopback `--host` is used without a password
- `/` serves the SPA shell, but `/api/tasks` returns `401` before login
- the browser login creates an `HttpOnly`, `SameSite=Strict` session cookie
- failed passwords eventually return `429` with `Retry-After`
- logout invalidates the session and the cookie-clearing response preserves `Secure` when the request is forwarded as HTTPS

For a VPS, put Marshal behind an HTTPS reverse proxy or use a private VPN such as Tailscale or WireGuard. The proxy must forward `/ws` as a WebSocket upgrade and set `X-Forwarded-Proto: https`; set `daemon.trustedProxy` only when the daemon is reachable exclusively through that proxy. Do not publish the plain-HTTP listener directly to the public internet. Authentication does not sandbox ACP agents, so test the daemon's OS account and explicit agent isolation policy separately.

## 6. Web board tests (daily-driving UX)

### 6.1 Startup and rendering

1. Ensure web bundle built (`pnpm run build:web`)
2. Run daemon and open `http://127.0.0.1:$PORT/`

Expected:

- board loads with columns by task status
- task cards show title/slug/status metadata
- selecting card opens detail panel

### 6.2 New task flow

1. Open New Task modal
2. Create with title only
3. Create with title + spec markdown
4. Try empty title

Expected:

- successful tasks appear in backlog quickly
- empty title shows error feedback

### 6.3 Task detail actions

Verify action visibility by state:

- backlog: Freeze only
- ready: no manual action
- building: re-queue/send-back (confirm required)
- validating: send-back (confirm required)
- review: approve/merge + send-back
- done: no action

Expected:

- optimistic update feel
- on failure, UI rolls back and shows an error

### 6.4 Spec authoring chat

For backlog task:

1. Send message
2. Confirm assistant reply appears
3. If assistant emits ` ```marshal-spec ` block, click **Update Spec**
4. Freeze task from panel

Expected:

- messages persist and render in order
- latest proposed spec can be applied
- freeze transitions task to `ready`

### 6.5 Review diff + merge

For review task:

1. Open diff panel and verify rendered hunks
2. Use Approve & Merge

Expected:

- merged task becomes `done`
- worktree/branch cleaned up

## 7. WebSocket and live-update tests

### 7.1 Socket connect snapshot

Connect to `ws://127.0.0.1:$PORT/ws`.

Expected:

- first event `connected` with task snapshot

### 7.2 Broadcast events

While socket connected, create/transition tasks via API or UI.

Expected:

- `task.created`, `task.transitioned`, `task.updated` events arrive
- two clients connected simultaneously see same broadcast

### 7.3 Connection robustness

Terminate a WS client abruptly.

Expected:

- daemon remains healthy (`/api/health` still 200)

### 7.4 Chat-first dogfooding flow

1. Open `/chat` and create a new thread with a configured ACP agent.
2. Send a short text prompt and confirm the streamed assistant response remains after reload.
3. Open a repository file from the Files pane, add a file mention to the draft, and send it.
4. Trigger an ACP permission request and approve once; repeat with deny and confirm the turn fails closed.
5. Attach a PNG or JPEG from the paperclip, drag an image onto the chat input, and send an image-only message.
6. Confirm the image appears in the transcript after reload. With an image-incapable agent, confirm sending reports an explicit unsupported-image error and does not silently drop the image.
7. Disconnect the browser or stop/restart the daemon. Confirm the header reports reconnecting, then the thread list and transcript recover from the daemon snapshot.
8. At a narrow mobile viewport, switch Files / Draft / Chat with the local pane selector, use the back button to return to threads, and confirm desktop still shows the panes side by side.

Expected:

- Invalid MIME, spoofed signatures, oversized files, and exhausted quotas show actionable upload errors.
- Failed sends preserve the uploaded image for retry; successful sends clear the attachment tray.
- Permission decisions never default on disconnect.

## 8. Static serving and routing tests

### 8.1 Bundle present

Expected:

- `/` serves SPA `index.html`
- unknown non-API route falls back to SPA entry
- `/assets/*` serves static assets with correct MIME

### 8.2 Bundle absent

Temporarily remove/rename `web/dist` and hit `/`.

Expected:

- `404` with clear "Web bundle not built" guidance

### 8.3 Safety checks

- `/api/*` must not be swallowed by SPA fallback
- `/assets/../...` traversal attempts must not expose files

## 9. Reliability and operational edge tests

### 9.1 Daemon port-file lifecycle

On `marshal start`:

- `.marshal/daemon.port` created with bound port

On clean shutdown (SIGINT/SIGTERM):

- `.marshal/daemon.port` removed

### 9.2 Port conflicts / bind failures

Start daemon on an occupied port.

Expected:

- startup fails clearly
- no stale `.marshal/daemon.port` left behind

### 9.3 Stale port file

Write bogus `.marshal/daemon.port`, then start daemon.

Expected:

- daemon overwrites with actual live port

### 9.4 Merge conflict recovery

Force diverged base vs task branch and attempt merge.

Expected:

- `merge_conflict`
- task stays `review`
- source checkout is not left in unresolved `UU` state

## 10. Suggested regression cadence

### Per PR (fast smoke)

1. onboarding fast path (`init`, `doctor`)
2. one full backlog->review loop
3. web board create + freeze + one transition
4. API negative checks (unknown field + invalid transition)

### Before release

1. full checklist in sections 3-9
2. both CLI-only and web-driven daily-driving paths
3. retry-cap + merge-conflict paths
4. WS multi-client broadcast path
