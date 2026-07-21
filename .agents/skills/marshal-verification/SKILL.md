---
name: marshal-verification
description: Verify and debug Marshal changes across the daemon, API, WebSocket, and web UI with Playwright CLI. Use after non-trivial implementation work, bug reproduction, or any flow that crosses the browser and daemon boundary.
---

# Marshal Verification

Use this skill for Marshal development verification, not for implementing Marshal's product-level validation workflows.

## Rules

- Read `docs/ARCHITECTURE.md` and `docs/PROJECT.md` before choosing assertions. Check `docs/HUMAN-TESTING-GUIDE.md` when it exists.
- Inspect the current diff and affected modules. Reproduce before editing when feasible.
- Test the narrowest boundary first, then the end-to-end flow.
- For web/daemon behavior, prove both sides. A successful click is not proof of API success or persistence.
- Use only `playwright-cli` for browser automation. Do not create a new Playwright test suite or use another browser tool.
- Keep logs, snapshots, screenshots, traces, and browser profiles under `/tmp/marshal-verification/`.
- Never include cookies, authorization headers, credentials, or agent secrets in evidence.
- Run verification commands sequentially, never in parallel.
- Do not stop or replace a server owned by another user or agent.

## Scope And Gates

- Backend: focused tests, direct API calls, logs, and read-only state inspection.
- Frontend: focused pure-logic tests plus a Playwright CLI flow.
- Web/daemon, WebSocket, auth, ACP sessions, durable operations, or persistence: verify browser, API, logs, and state, correlating IDs and timestamps where available.
- Layout or interaction changes: test desktop and `390x844`.

Run focused checks first. Finish with the applicable gate:

```bash
# Backend-only
pnpm run check
pnpm run test

# Web or cross-boundary
pnpm run check:all
pnpm run test:all
```

## Server

Expected development endpoints:

- Web: `http://localhost:5173`
- Daemon/API: `http://127.0.0.1:7433`
- WebSocket: `ws://127.0.0.1:7433/ws`, proxied by Vite as `/ws`

Check both layers before starting a server:

```bash
curl -fsS http://127.0.0.1:7433/api/health
curl -fsS http://localhost:5173/ >/dev/null
node ./bin/marshal status
```

If no healthy server exists, start one with a unique artifact directory and retain its PID and log:

```bash
ARTIFACT_DIR="/tmp/marshal-verification/$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$ARTIFACT_DIR"
nohup pnpm run dev >"$ARTIFACT_DIR/dev.log" 2>&1 &
printf '%s\n' "$!" >"$ARTIFACT_DIR/dev.pid"
```

Stop only the process tree you started. Do not use broad process-killing commands. Vite being reachable does not prove the daemon is healthy; the daemon port is also recorded in `~/.marshal/daemon.port` and `.marshal/daemon.port`.

## Playwright CLI


Run from `ARTIFACT_DIR` so generated `.playwright-cli` files stay out of the repository:

```bash
SESSION="marshal-verify-<unique-id>"
playwright-cli -s="$SESSION" open --browser=chromium http://localhost:5173
playwright-cli -s="$SESSION" tracing-start
playwright-cli -s="$SESSION" goto http://localhost:5173/<route>
playwright-cli -s="$SESSION" snapshot
```

Use refs from the latest snapshot. Re-snapshot after navigation, loading, modals, or substantial DOM changes. Prefer roles, labels, test IDs, and `find` over brittle selectors. Wait for an observable UI, URL, or request state rather than arbitrary sleeps.

Collect only relevant evidence:

```bash
playwright-cli -s="$SESSION" console error
playwright-cli -s="$SESSION" requests
playwright-cli -s="$SESSION" request <index>
playwright-cli -s="$SESSION" response-body <index>
playwright-cli -s="$SESSION" screenshot --filename="$ARTIFACT_DIR/failure.png"
playwright-cli -s="$SESSION" tracing-stop
playwright-cli -s="$SESSION" close
```

Inspect the suspicious request, not every request. Replay it with `curl -i` when useful. A screenshot proves appearance only; it does not prove API or persistence success. Check the dev server logs for backend logs

## Diagnosis

For browser failures:

1. Identify the failed or suspicious Playwright request.
2. Inspect its status, request details, and response body.
3. Replay the endpoint directly with `curl -i`.
4. Correlate the response with daemon logs and operation/thread/task/run IDs.
5. Inspect SQLite or filesystem state read-only only when the failure crosses a persistence boundary. Machine state is normally under `~/.marshal/`; repository state is under `.marshal/`.

Use `LOG_LEVEL=debug` only when normal logs are insufficient. If another agent owns the server and its logs are unavailable, say so and do not claim backend verification from browser output alone.

## Independent Verification

Use a fresh read-only verification subagent for risky cross-boundary changes involving WebSockets, authentication, ACP lifecycle, durable operations, permissions, persistence, workflows, or difficult regressions. Do not use one for documentation-only, trivial styling, or merely repeating checks.

Give it the target behavior, diff scope, server URL, and log path:

```text
Independently verify the current Marshal worktree. Load and follow the
marshal-verification skill. Do not edit source files. Inspect the diff and
architecture, reproduce the target behavior, run focused direct checks, and
use Playwright CLI when browser behavior is involved. Reuse the healthy dev
server; do not start a duplicate. Correlate browser, API, logs, and persisted
state. Return findings first, exact checks, evidence paths, and uncertainty.
```

The primary agent owns fixes and must rerun any failed verification.

## Report

Always finish with:

```text
Result: verified | failed | not reproduced | inconclusive
Scope: behavior and boundaries checked
Findings: confirmed defects first, with file/line references when applicable
Checks: commands and focused flows run
Evidence: relevant logs, screenshots, traces, requests, and response details
Remaining uncertainty: untested paths or unavailable evidence
```

Do not report `verified` if the target behavior was not exercised or a required boundary was only inferred.
