---
name: marshal-verification
description: Verify and debug changes to the Marshal codebase, including local daemon, API, WebSocket, and browser behavior with Playwright CLI. Use after non-trivial implementation work, for bug reproduction, or when frontend and backend behavior must be correlated.
---

# Marshal Verification

Use this skill for developing Marshal, not for implementing Marshal's product-level validation workflows.

## Verification principles

- Read `docs/ARCHITECTURE.md` first and use `docs/PROJECT.md` for product intent. Use `docs/HUMAN-TESTING-GUIDE.md` for relevant manual scenarios; update it when a product flow changes.
- Inspect the current diff and affected modules before choosing checks.
- Reproduce the reported behavior before editing when feasible.
- Test the narrowest boundary first, then the full user flow.
- For web/daemon changes, verify both browser behavior and the underlying API or daemon state. A successful click does not prove the backend succeeded.
- Use only `playwright-cli` for browser automation. Do not substitute agent-browser, Playwright MCP, or a new Playwright test suite.
- Keep screenshots, traces, snapshots, logs, and browser profiles under `/tmp/marshal-verification/`, never in the repository.
- Never expose cookies, authorization headers, credentials, or agent secrets in evidence.

## Decide the verification scope

- Backend logic: focused tests, direct API calls, logs, and state inspection.
- Frontend logic: focused pure-logic tests plus a Playwright CLI user flow.
- Web/daemon, WebSocket, authentication, ACP session, durable operation, or workflow changes: verify both sides and correlate timestamps and identifiers.
- UI layout or interaction changes: check desktop and a narrow viewport.
- Run verification commands sequentially, never in parallel.

Run focused checks first. Before finishing, use the applicable full gate:

```bash
# Backend-only
pnpm run check
pnpm run test

# Web or cross-boundary work
pnpm run check:all
pnpm run test:all
```

## Local development server

The normal development command builds the daemon, starts it on the expected port, and starts Vite:

```bash
pnpm run dev
```

Expected development endpoints:

- Web application: `http://localhost:5173`
- Daemon/API: `http://127.0.0.1:7433`
- WebSocket: `ws://127.0.0.1:7433/ws`, proxied by Vite at `/ws`

Before starting another server, check both layers:

```bash
curl -fsS http://127.0.0.1:7433/api/health
curl -fsS http://localhost:5173/ >/dev/null
node ./bin/marshal status
```

Do not mistake a working Vite shell for a working daemon. Vite proxies `/api` and `/ws` to port `7433`. The daemon also records its live port in `~/.marshal/daemon.port` and `.marshal/daemon.port`.

Reuse a healthy server. Do not replace or stop a server owned by the user or another agent. If no server is running, start one in a persistent terminal and retain its output. When background output is necessary, create a unique artifact directory and redirect the command there:

```bash
ARTIFACT_DIR="/tmp/marshal-verification/$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$ARTIFACT_DIR"
pnpm run dev >"$ARTIFACT_DIR/dev.log" 2>&1 &
printf '%s\n' "$!" >"$ARTIFACT_DIR/dev.pid"
```

Stop only the process you started. Do not use broad process-killing commands.

## Logs and backend diagnosis

`pnpm run dev` prefixes process output with `daemon` and `web`. Marshal's daemon logs are Pino JSON written to stderr; Vite errors appear in the same development output. Use `LOG_LEVEL=debug pnpm run dev` only when normal logs are insufficient.

Inspect the retained log around the reproduction rather than reading it indiscriminately:

```bash
tail -n 200 "$ARTIFACT_DIR/dev.log"
rg -n 'error|warn|failed|exception|HTTP server listening' "$ARTIFACT_DIR/dev.log"
```

For a browser failure:

1. Identify the request with Playwright CLI.
2. Inspect its request and response details.
3. Replay the endpoint directly with `curl -i` when useful.
4. Correlate status, body, daemon log entry, operation ID, thread ID, task slug, or run ID.
5. Inspect SQLite or filesystem state read-only only when the failure crosses a persistence boundary. Machine state is normally under `~/.marshal/`; repository state is under `.marshal/`.

If the server belongs to another agent and its logs are unavailable, say so. Do not claim backend verification from browser output alone.

## Playwright CLI debugging loop

Confirm `playwright-cli --help` works. If it is unavailable, report the blocker; do not install it as part of this skill.

Use a unique named session. Run browser commands with the shell working directory set to the artifact directory so Playwright's generated `.playwright-cli` snapshots do not pollute the worktree.

```bash
SESSION="marshal-verify-<unique-id>"

playwright-cli -s="$SESSION" open
playwright-cli -s="$SESSION" tracing-start
playwright-cli -s="$SESSION" goto http://localhost:5173
playwright-cli -s="$SESSION" snapshot
```

Use refs from the latest snapshot for interactions:

```bash
playwright-cli -s="$SESSION" click e15
playwright-cli -s="$SESSION" fill e21 "value"
playwright-cli -s="$SESSION" press Enter
playwright-cli -s="$SESSION" snapshot
```

- Re-snapshot after navigation, modal changes, loading transitions, or substantial DOM updates; refs can become stale.
- Prefer snapshot refs, roles, labels, or test IDs over brittle CSS selectors.
- Use `find "text"` or a shallower `snapshot --depth=4` when a full snapshot is noisy.
- Wait for observable UI, URL, or request state. Do not use arbitrary sleeps unless diagnosing timing behavior.

After reproducing, collect only relevant evidence:

```bash
playwright-cli -s="$SESSION" console error
playwright-cli -s="$SESSION" requests
playwright-cli -s="$SESSION" request <index>
playwright-cli -s="$SESSION" screenshot --filename="$ARTIFACT_DIR/failure.png"
playwright-cli -s="$SESSION" tracing-stop
playwright-cli -s="$SESSION" close
```

Use `request <index>` for the failing or suspicious call, not every request. A screenshot is visual evidence, not proof of API or persistence success. Record the trace path printed by `tracing-stop`.

For responsive changes, repeat the relevant flow after `resize 390 844`, then restore a desktop viewport such as `resize 1440 900`. Use `open --browser=firefox` or `open --browser=webkit` only when the change or bug is browser-specific.

## Independent verification subagent

Spawn a fresh verification subagent after the implementing agent has run basic checks when independent context is valuable. Do this for non-trivial changes involving web/daemon boundaries, WebSockets, authentication or permissions, ACP process/session lifecycle, durable operations, persistence transitions, workflow state, difficult regressions, or risky UI flows.

Do not spawn one for documentation-only work, trivial styling or copy changes, localized refactors with strong tests, or merely to repeat the same check and test commands. If you are already the verification subagent, do not spawn another verifier.

The verifier is read-only with respect to source code. It may write evidence under `/tmp/marshal-verification/`. Give it the target behavior, current diff scope, server URL, log path if available, and this prompt:

```text
Independently verify the current Marshal worktree. Load and follow the
marshal-verification skill. Do not edit source files. Inspect the diff and
relevant architecture, reproduce the target behavior, run focused direct
checks, and use Playwright CLI when browser behavior is involved. Reuse the
existing healthy dev server; do not start a duplicate. Correlate browser,
API, logs, and persisted state where relevant. Return findings first, exact
checks run, evidence paths, and remaining uncertainty.
```

The implementing agent owns fixes. If a verifier finds a defect, fix it in the primary context and rerun the exact failed verification; resume the same verifier when practical.

## Report

Finish with:

```text
Result: verified | failed | not reproduced | inconclusive
Scope: behavior and boundaries checked
Findings: confirmed defects first, with file/line references when applicable
Checks: commands and focused flows run
Evidence: relevant log, screenshot, trace, request, and response paths/details
Remaining uncertainty: untested paths or unavailable evidence
```

Do not report `verified` if the target behavior was not exercised or if a required boundary was inferred rather than observed.
