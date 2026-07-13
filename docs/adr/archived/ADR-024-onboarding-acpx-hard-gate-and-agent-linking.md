# ADR-024: Onboarding acpx Hard-Gate and Agent Linking via ACPX Session Probe

## Status

Accepted — 2026-07-13. Implemented in `src/setup/`, `src/worktree/config.ts`, `src/cli.ts`, and `tests/`. Moved to `docs/adr/archived/`.

Decisions 4 (full `AGENT_INSTALL_HINTS` registry) and 5 (orchestrator `resolveAgentId("builder")` fix) were already implemented by ADR-023 before this ADR was applied; they required no additional work here. Decision 3's reference to `AGENT_ID_DEFAULTS` required reintroducing the constant in `src/worktree/config.ts` (ADR-023 Decision 3 had deleted it) — the constant is used only by `marshal init` to write a fresh config; `resolveAgentId` still throws `MissingAgentIdError` on missing config keys (ADR-023's runtime behavior is preserved).

Retracts ADR-020 Phase 2's "offer to install acpx in-process" behavior.

## Context

### Issue A — `marshal init` fakes an acpx install and then fails anyway

Observed first-run on a clean VPS:

```
✗ acpx (not on PATH) — fix: npm i -g acpx@0.12.0 — docs: https://github.com/openclaw/acpx
✗ acpx version (acpx not installed) — fix: npm i -g acpx@0.12.0
acpx not found. Run this command in your terminal:

  npm i -g acpx@0.12.0

Then press Enter to continue [y/N] Y
✓ npm i -g acpx@0.12.0
✗ acpx (not on PATH) — fix: npm i -g acpx@0.12.0 — docs: https://github.com/openclaw/acpx
✗ acpx version (acpx not installed) — fix: npm i -g acpx@0.12.0
✗ acpx is required and is still missing. Install with `npm i -g acpx@0.12.0` and re-run `marshal init`.
```

Root cause, `src/setup/init.ts:267-275` (`maybeInstallAcpx`):

```ts
async function maybeInstallAcpx(prompt: YesNoPrompt, versionRange: string): Promise<void> {
  const cmd = `npm i -g acpx@${versionRange}`;
  if (await prompt(`acpx not found. Run this command in your terminal:\n\n  ${cmd}\n\nThen press Enter to continue`)) {
    print(`✓ ${cmd}`);   // <-- lies: nothing was installed
  }
}
```

Three things are wrong at once:

1. **The install is never run.** The function only prints `✓ npm i -g acpx@0.12.0`. It does not call `runInstall`, does not spawn `npm`, does not wait. The `✓` is a success marker for an action that did not happen. This is a trust bug of the same class as ADR-022 Issue A ("user said no; tool wrote anyway") — here it is "tool said it did; it didn't."
2. **The prompt shape is wrong for the intent.** The copy says "Run this command in your terminal … Then press Enter to continue," but the prompt is a `[y/N]` yes/no (`defaultYesNo`, `init.ts:30-38`). There is no "press Enter" pause, and answering `Y` does not block long enough for the user to switch terminals and run the install. The flow falls straight through to the re-probe at `init.ts:121`.
3. **The re-probe cannot succeed.** Even if the user did run `npm i -g acpx@0.12.0` in another terminal during the prompt, the marshal process's `PATH` was fixed at spawn time; a freshly installed global binary is not visible to `which acpx` in this process without a re-hash, and on most VPS installs `npm i -g` requires sudo the marshal process does not have. The re-probe at `init.ts:121` is structurally doomed.

This has survived "multiple iterations" because each fix tried to make the in-process install work (run `npm`, re-check, retry). The fix inverts that: **don't try to install acpx from inside marshal at all.** Say it's missing, give the exact command, stop.

### Issue B — "How do we know which coding agents are linked to marshal?"

The user asked whether `marshal init` should `which opencode` / `which pi` / `which claude` / `which codex` to detect linked agents, or whether acpx exposes a way to query them. Research against the acpx CLI docs (`acpx.sh/CLI.html`, `acpx.sh/agents.html`, referenced 2026-07-13, acpx 0.12.x):

- **acpx has no `--list-agents` command.** The built-in registry (~19 friendly names → ACP adapter commands) is published at `acpx.sh/agents.html` but is not queryable at runtime.
- **Most agents are not global binaries.** The registry maps names like `codex` → `npx -y @agentclientprotocol/codex-acp`, `claude` → `npx -y @agentclientprotocol/claude-agent-acp`, `opencode` → `npx -y opencode-ai acp`. acpx auto-fetches the adapter via `npx` on first use. So `which codex` is **wrong by construction**: it reports "missing" for an agent that works perfectly well, because the adapter is fetched on first handshake, not pre-installed. Only a few agents (`gemini`, `cursor`, `kimi`, `qwen`, …) ship as direct binaries on PATH.
- **ACPX sessions are zero-cost probes.** `acpx <agent> sessions new` spawns the adapter, runs ACP `initialize` (capability negotiation, may surface auth issues) and `session/new` (protocol-level session creation). No LLM prompt is sent, so **zero tokens are consumed**. The session is then cleaned up with `acpx <agent> sessions close`. This proves the adapter binary is reachable, ACP capability negotiation passes, and the agent can be spawned — without costing a model call.
- **`acpx <agent> exec 'hello'`** (the current `checkAgentHandshake`) does the same plus a full prompt round-trip, consuming tokens. It is the authoritative end-to-end check, but for a probe that just needs to know "is this agent configured and adaptable," the session-only probe is sufficient and cheaper.
- **OpenClaw's integration confirms the pattern.** OpenClaw routes `agentId` strings (`"codex"`, `"claude"`, …) against the acpx backend and probes health with `/acp doctor`, which runs a handshake against a configured probe agent. It does **not** enumerate installed agent binaries. Marshal is in the same position: the link is the `agentId` string, and the check is through acpx.

Conclusion: Marshal should **not** check for agent CLIs on PATH. The "is this agent linked" check is `acpx <agent> sessions new` + `acpx <agent> sessions close` — zero token cost, proves adapter reachability + ACP capability. acpx owns agent resolution (registry → adapter command → `npx` auto-fetch → `--agent` escape hatch); Marshal owns only the `agentId` string in config and the session-probe verdict.

### Current code state (what ships today, post-ADR-022)

- `src/worktree/config.ts:63-67` — `AGENT_ID_DEFAULTS = { builder: "opencode", validator: "pi", specAuthor: "opencode" }`. `resolveAgentId` (`config.ts:74-86`) returns these defaults when the config key is missing, with `specAuthor` silently falling back to `builder`.
- `src/daemon/orchestrator.ts:34` — `const BUILDER_AGENT_ID = "opencode" as const;`, used directly at `orchestrator.ts:174,185`. The builder path bypasses `resolveAgentId("builder")` entirely, so configuring `agents.builder: "codex"` **silently does nothing**. This is the regression ADR-019 should have caught.
- `src/setup/hints.ts:17-25` — `AGENT_INSTALL_HINTS` has 4 entries (`opencode`, `pi`, `claude-code`, `codex`) with outdated/wrong package names (`@anthropic-ai/claude-code-acp` is not the package acpx runs; acpx runs `@agentclientprotocol/claude-agent-acp`). `maybeInstallAgent` (`init.ts:277-291`) runs `npm i -g <hint.pkg>` in-process — wrong for the majority of agents, which are `npx -y`-fetched by acpx on session creation, not global installs.
- `src/setup/preflight.ts:205-224` — `checkAgentInstalled` shells out to `acpx <agent> --help`. The acpx CLI grammar (`acpx.sh/CLI.html`) does not document `--help` as a per-agent probe; the documented probe is `sessions new` / `exec`. The `--help` call is a weaker pre-check that this ADR replaces with the session probe.
- `src/setup/preflight.ts:226-260` — `checkAgentHandshake` uses `acpx <agent> exec 'hello'` which costs tokens. Replaced by the session probe.

### Design constraints

- **No new runtime dependencies.** Same shell-out-to-PATH approach as ADR-020/022.
- **Preserve the existing-config fast path.** A machine with a complete `~/.marshal/config.json` reports `✓ machine already configured` and skips the acpx/agent checks (`init.ts:93-100`).
- **Preserve `marshal doctor` as read-only.** It re-probes configured agents; it does not mutate.
- **Preserve the open agent-ID model (ADR-019).** No new allowlist. The registry table is advisory display + docs, not a gate.
- **Do not regress the idempotent re-run.** Second repo on a configured machine stays near-instant.
- **Be honest in the CLI.** No success marker for an action that did not happen (the lesson from Issue A and ADR-022 Issue A).
- **Zero token cost for probes.** No LLM calls during `init` or `doctor`.

## Decisions

### 1. acpx is a hard-gate: check first, and if it is missing, print the install command and stop

`marshal init` and `marshal doctor` run the acpx check (Phase 2) before any agent work. If acpx is not on PATH or its version is outside the accept range, marshal:

- prints the exact install command (`npm i -g acpx@<ACPX_INSTALL_PIN>`, currently `0.12.0`, from `src/agent/acpx-adapter.ts:26`),
- prints the docs link,
- **stops.** No in-process `npm i -g` attempt, no fake `✓` line, no re-probe loop, no continuation into Phase 3 agent probes.

In `src/setup/init.ts`:

- `maybeInstallAcpx` (`init.ts:267-275`) is **deleted**. The `prompt` parameter and `YesNoPrompt` type are removed from `runInit()`'s interface since init is now non-interactive (Decision 3).
- The re-probe block at `init.ts:117-123` is **deleted**. After the Phase 2 acpx check, if any result is `fail`, init prints the "still missing" message and returns `{ ok: false }` immediately.
- `InitOptions.prompt` is removed from the interface.

In `src/setup/preflight.ts`:

- `checkAcpxPath` (`preflight.ts:133-155`) and `checkAcpxVersion` (`preflight.ts:157-177`) are unchanged. The `fail` CheckResult from `checkAcpxPath` carries the `fix` field with the install command, which `init.ts` prints directly.

Rationale:

- **`npm i -g` is not reliably runnable from inside marshal.** On a typical VPS the global npm prefix is owned by root; a non-root daemon process cannot install globally without sudo, and shelling out to `sudo` from an onboarding prompt is a security and UX hazard we should not own.
- **PATH does not re-hash within a process.** Even a successful global install would not be visible to `which acpx` in the current marshal process without a restart, so the re-probe is theater.
- **The user is already in a terminal.** Telling them the one command to run, then asking them to re-run `marshal init`, is one extra round-trip and zero ambiguity. It is strictly more honest than a fake `✓`.
- **Running agent probes against a missing acpx is noise.** Every agent would fail with "acpx not installed" — the existing comment at `init.ts:124-130` already argues this; this decision just makes the halt happen at the right place without the doomed install detour.

ADR-020 Phase 2's "If the user consents to install, setup runs the install command, re-checks, and reports success/failure" is **retracted for acpx.** ADR-020's broader preflight shape (phases, idempotency, `doctor`) stands; only the acpx in-process install is retracted.

### 2. Agent linking is via the zero-cost acpx session probe, not CLI presence or a token-consuming handshake

Marshal **never** runs `which opencode`, `which pi`, `which claude`, `which codex`, etc. The "is this agent linked and usable" check is:

```
acpx <agent> sessions new   # spawn adapter, ACP initialize + session/new (zero tokens)
acpx <agent> sessions close # clean up
```

This replaces the current `exec 'hello'` handshake (`checkAgentHandshake`, `preflight.ts:226-260`) with a session-only probe that:

- Resolves the agent via ACPX's registry (or `--agent` escape hatch)
- Spawns the adapter process (triggers `npx -y` download on first use if the agent is `npx`-based)
- Runs ACP `initialize` — capability negotiation, auth handshake
- Runs ACP `session/new` — creates a protocol-level session
- Exits non-zero if the adapter binary is missing, auth fails during `initialize`, or the agent doesn't support the expected protocol
- **Zero LLM tokens consumed** — no model call is made

The `close` step cleans up the session artifact. If `sessions new` fails, the `sessions close` is skipped (there is no session to close).

Implementation changes:

- `checkAgentHandshake` (`preflight.ts:226-260`) is rewritten to use `sessions new` instead of `exec 'hello'`. The return signature stays the same (`CheckResult`), but the probe is cheaper and the timeout can be reduced (15s → 10s since there is no model call).
- `checkAgentInstalled` (`preflight.ts:205-224`) is **removed**. Its `acpx <agent> --help` pre-check is weaker than the session probe and uses an undocumented probe surface. The `AgentCheckResult.installed` field is dropped from `AgentCheckResult`.
- `maybeInstallAgent` (`init.ts:277-291`) is **removed**. Marshal does not install agents. acpx's registry maps each friendly name to an adapter command, and for `npx -y <pkg>` adapters (codex, claude, opencode, kilocode, mux, …) acpx fetches the adapter on first session creation. There is nothing for marshal to `npm i -g`. For direct-binary agents (gemini, cursor, kimi, …) the session probe fails with a clear "command not found" from acpx and the hint points at the agent's own docs.
- `AgentCheckResult` is simplified: `installed` is removed; only `role`, `agentId`, and `handshake` (the single `CheckResult` from the session probe) remain.

This is the answer to the user's question: **we check with acpx, because acpx is the substrate that owns agent resolution.** Checking CLI presence is wrong for `npx`-fetched adapters and would produce false negatives for the majority of the registry. Session creation is the cheapest probe that proves real adapter reachability.

### 3. `marshal init` is non-interactive by default; no prompts, no consent flags

`marshal init` is always non-interactive. No `--non-interactive` flag, no `--yes` flag, no `MARSHAL_INIT_YES` env var. The user runs `marshal init` to initialize; that is the consent. If they do not want files written, they do not run the command.

The flow:

1. Phase 1: system prereqs (node, git, pnpm). Print status lines. `fail` → exit non-zero. `warning` → continue (pnpm is not a hard dependency).
2. Phase 2: acpx check. If `fail` → print install command + docs, exit non-zero. If `warning` (version mismatch) → continue (the version pin is advisory; the user can fix it later).
3. Phase 3: agent probing is **removed from init**. `marshal init` does not probe agents. It writes the config with the defaults from `AGENT_ID_DEFAULTS` (Decision 4's note) and initializes the repo state. Agent verification is `marshal doctor`'s job.
4. Phase 4/5/6 (merged): generate config from defaults, merge with any existing config, write `~/.marshal/config.json`, init repo state, open DB. No prompt, no preview.

Changes to `src/setup/init.ts`:

- `InitOptions.nonInteractive` is removed.
- `InitOptions.yes` is removed.
- `envYes` function and `MARSHAL_INIT_YES` handling are removed.
- `InitOptions.prompt` is removed (no more console prompts).
- `MaybeInstallPnpm` is removed (no interactive install offers; pnpm is a warning, not a fail, and the user runs `npm i -g pnpm` themselves).
- `MaybeInstallAcpx` is removed (Decision 1).
- `MaybeInstallAgent` is removed (Decision 2).
- `printConfigPreview` is removed (no preview to show).
- The merged prompt at `init.ts:197-206` is replaced with unconditional `writeInitFiles` when `machineNeedsConfig || repoNeedsInit`.
- `runDoctor` is unchanged (it is already read-only and non-interactive).

Changes to `src/setup/preflight.ts`:

- `machineAlreadyConfigured` (`preflight.ts:281-292`) is unchanged. It checks for `cfg.acpx && cfg.agents?.builder && cfg.agents?.validator`. A complete config from a previous init takes the fast path.
- `generateConfig` (`preflight.ts:294-305`) is unchanged — it writes the resolved builder/validator/specAuthor ids. With defaults, this writes `opencode`/`pi`/`opencode`. The generated config is a complete starting point; the user overrides by editing `~/.marshal/config.json` directly.

Rationale:

- `marshal init` is a setup command, not a diagnostic. The user's intent is to initialize. Prompts add friction without value — the defaults are reasonable and the user can override them in the config file at any time.
- `marshal doctor` is the read-only diagnostic. The user runs `doctor` to check their setup, verify agents, and diagnose issues. Keeping init simple and doctor thorough splits concerns cleanly.
- Removing the `--non-interactive` / `--yes` / `prompt` machinery simplifies the code and the mental model: one command, no flags, just does it.

### 4. `AGENT_INSTALL_HINTS` becomes the full acpx built-in registry; `pkg` is renamed `acpxCommand`

`src/setup/hints.ts:17-25` (4 entries, wrong packages) is replaced with the acpx built-in registry verbatim from `acpx.sh/agents.html` (referenced 2026-07-13). This adopts ADR-023 Decision 5's table:

```ts
export interface AgentInstallHint {
  acpxCommand: string;   // was `pkg`; now what acpx actually runs
  docs: string;
}

export const AGENT_INSTALL_HINTS: Record<string, AgentInstallHint> = {
  pi:           { acpxCommand: "npx pi-acp",                            docs: "https://github.com/mariozechner/pi" },
  openclaw:     { acpxCommand: "openclaw acp",                          docs: "https://github.com/openclaw/openclaw" },
  codex:        { acpxCommand: "npx -y @agentclientprotocol/codex-acp", docs: "https://codex.openai.com" },
  claude:       { acpxCommand: "npx -y @agentclientprotocol/claude-agent-acp", docs: "https://docs.anthropic.com/claude-code" },
  gemini:       { acpxCommand: "gemini --acp",                          docs: "https://github.com/google/gemini-cli" },
  cursor:       { acpxCommand: "cursor-agent acp",                      docs: "https://cursor.com/docs/cli/acp" },
  copilot:      { acpxCommand: "copilot --acp --stdio",                 docs: "https://docs.github.com/copilot/how-tos/copilot-chat/use-copilot-chat-in-the-command-line" },
  droid:        { acpxCommand: "droid exec --output-format acp",        docs: "https://www.factory.ai" },
  "fast-agent": { acpxCommand: "uvx fast-agent-mcp acp",                docs: "https://fast-agent.ai/" },
  "grok-build": { acpxCommand: "grok agent stdio",                      docs: "https://docs.x.ai/build/overview" },
  iflow:        { acpxCommand: "iflow --experimental-acp",             docs: "https://github.com/iflow-ai/iflow-cli" },
  kilocode:     { acpxCommand: "npx -y @kilocode/cli acp",              docs: "https://kilocode.ai" },
  kimi:         { acpxCommand: "kimi acp",                              docs: "https://github.com/MoonshotAI/kimi-cli" },
  kiro:         { acpxCommand: "kiro-cli-chat acp",                    docs: "https://kiro.dev" },
  mux:          { acpxCommand: "npx -y mux@^0.27.0 acp",                docs: "https://mux.coder.com" },
  opencode:     { acpxCommand: "npx -y opencode-ai acp",               docs: "https://opencode.ai" },
  qoder:        { acpxCommand: "qodercli --acp",                        docs: "https://docs.qoder.com/cli/acp" },
  qwen:         { acpxCommand: "qwen --acp",                             docs: "https://github.com/QwenLM/qwen-code" },
  trae:         { acpxCommand: "traecli acp serve",                   docs: "https://docs.trae.cn/cli" },
};
```

Rationale: the hint is now **advisory display + docs**, not an install command. `acpxCommand` lets `marshal doctor` render a useful fix line when the session probe fails (e.g. "agent `gemini` not available — `gemini --acp` not found on PATH; see https://github.com/google/gemini-cli"). Agents not in the table are still usable (`AgentId` is `string`, ADR-019); they fall back to "install manually per your agent's docs" + a generic `https://acpx.sh/agents.html` link. `factory-droid`/`factorydroid` aliases are not enumerated (acpx resolves both to `droid`).

`AGENT_ID_DEFAULTS` (`src/worktree/config.ts:63-67`) is **kept unchanged** — `opencode`/`pi`/`opencode` are reasonable defaults. They are the agents the project was built and tested against, and the `AGENT_INSTALL_HINTS` table makes them probeable by `doctor`. Changing defaults is a separate decision deferred until there is evidence that a different pair is more commonly installed.

### 5. The orchestrator stops hard-coding `opencode` for the builder

`src/daemon/orchestrator.ts:34` (`const BUILDER_AGENT_ID = "opencode" as const;`) is deleted. The builder path at `orchestrator.ts:174,185` calls `resolveAgentId("builder")` exactly as the validator path already does (`orchestrator.ts:346`). `runLog.startRun(task.id, "builder", builderAgentId, prompt)` and `agent.spawn(worktree.path, builderAgentId, spawnOpts)` use the resolved id.

This is a bug fix independent of the defaults question. Even though the default for `builder` happens to be `"opencode"`, a user who configures `agents.builder: "codex"` in `~/.marshal/config.json` expects the builder to run `codex`, not `opencode`. The hard-coded constant silently defeats that config. The fix routes through `resolveAgentId("builder")` which consults `config.agents.builder` first and falls back to the default.

### 6. Tests are updated for the new probe and non-interactive init

- **`src/setup/init.test.ts`** — the broken `maybeInstallAcpx` path is deleted. Tests assert that (a) a missing acpx produces exactly one install-command line and exits non-zero without attempting an install, (b) no `✓ npm i -g acpx` line appears, (c) no `prompt` / `yes` / `nonInteractive` flags appear in the `runInit` call signature, (d) init writes `agents.{builder,validator,specAuthor}` with the defaults from `AGENT_ID_DEFAULTS`, (e) the existing-config fast path is unchanged.
- **`src/setup/preflight.test.ts`** — `checkAgentInstalled` tests are deleted with the function. `checkAgentHandshake` tests are rewritten to assert the `sessions new` + `sessions close` probe instead of `exec 'hello'`. No `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` strings appear (carried from ADR-022).
- **`src/daemon/orchestrator.test.ts` / `loop.test.ts` / `runs-api.test.ts`** — the `agentId: "opencode"` assertions gain a sibling asserting the builder call uses `resolveAgentId("builder")`'s return value, not a constant (regression test for Decision 5).
- **`src/agent/acpx-adapter.test.ts`** — add a parametrized case running the spawn/prompt/cancel round-trip with `"codex"` and `"claude"` to pin ADR-019's pass-through against future hard-codes.

### 7. Doc edits

- **`docs/PROJECT.md` §3.3** — "Starting agents: opencode as builder, pi as validator" → "Starting agents: opencode and pi by default (`AGENT_ID_DEFAULTS` in `src/worktree/config.ts`). Configurable via `agents.{builder,validator,specAuthor}` in `~/.marshal/config.json`. Any agent in the acpx built-in registry (`acpx.sh/agents.html`) or any `--agent <command>` token works."
- **`docs/PROJECT.md` §4** — "ACPX is alpha and its CLI/runtime interfaces are expected to change" — no change (ADR-023 Decision 1 is not yet accepted; PROJECT.md stays consistent with the current sole-substrate decision from ADR-003).
- **`AGENTS.md`** — add a note under Session start that `marshal init` is non-interactive and halts if acpx is missing.

## Consequences

- **The first-run trust bug is fixed.** acpx missing → one clear line with the exact command → halt. No fake `✓`, no doomed re-probe, no `sudo` from inside marshal. The user runs one command in their own terminal (where they own sudo and PATH) and re-runs `marshal init`.
- **Zero token cost for all probes.** `marshal init` probes nothing beyond `node --version`, `git --version`, `pnpm --version`, `which acpx`, and `acpx --version`. `marshal doctor` probes agents via `acpx <agent> sessions new` + `close` — protocol-level only, no LLM calls.
- **Marshal stops pretending to install or detect agents.** `npm i -g <agent>` lines disappear from `init` output. The session probe through acpx is the only "is this agent usable" signal, which is correct for `npx`-fetched adapters (the majority of the registry) and matches how OpenClaw treats the acpx backend.
- **One real regression fixed.** `BUILDER_AGENT_ID = "opencode"` (orchestrator.ts:34) is deleted; `agents.builder` now actually controls the builder.
- **`marshal init` is simple and fast.** No prompts, no flags, no consent gates. Check prereqs, check acpx (halt if missing), write config, init repo. Done. The existing-config fast path keeps second-repo init instant.
- **`marshal doctor` is the diagnostic surface.** It re-probes configured agents via the zero-cost session probe, reports failures with the `AGENT_INSTALL_HINTS` fix line, and is the answer to "are my linked agents healthy."
- **`AGENT_INSTALL_HINTS` is now a 19-row advisory table.** Maintenance cost: refresh when ACPX adds/removes a built-in. Mitigation: it is advisory (the session probe is authoritative), so a stale row degrades to "install manually per your agent's docs" — no correctness impact.
- **`acpx <agent> --help` is no longer probed.** The session probe (`sessions new`) is the documented and supported surface. The pinned version range (`>=0.12.0 <0.13.0`) protects against CLI drift.

## Open questions (deferred)

- **Session probe failure modes.** If `sessions new` fails because the adapter binary is missing, ACPX prints a clear error. If it fails because auth is missing during `initialize`, the error may be agent-specific. The probe's stderr is surfaced verbatim in the `CheckResult.detail` field. Deferred: if specific agents produce unhelpful error messages, the `AGENT_INSTALL_HINTS` table can be extended with a `probeErrorHint` field.
- **Session cleanup on probe failure.** If `sessions new` succeeds but `sessions close` fails (e.g., the adapter crashed), a dangling session record remains in `~/.acpx/sessions/`. This is harmless — the session is closed automatically on next use or pruned by `acpx <agent> sessions prune`. Deferred: a `--ttl 0` or `--timeout 1` flag on the probe could make sessions fail fast.
- **Per-agent prompt templates.** ADR-023 deferred this; the same answer applies here.
- **Decorrelated builder/validator advisory note.** Tenet 4 suggests a note in the config file or `doctor` output if the user picks the same agent for both roles. Deferred.
- **Updating defaults.** `opencode`/`pi` are the current defaults. If a future survey shows that `codex`/`claude` are more commonly installed by marshal's target audience, a separate ADR can change them. Not in scope here.

## Related

- `docs/adr/ADR-023-acpx-as-sole-agent-substrate.md` (Proposed) — Decision 2 (orchestrator hard-code fix) is implemented here. The remaining decisions (1, 3–6) are not addressed by this ADR; ADR-023 stays Proposed.
- `docs/adr/archived/ADR-022-onboarding-preflight-revisions.md` — Decision 2 (handshake is authoritative, no env-var inspection). Decision 2 here builds on it but replaces the `exec 'hello'` handshake with a zero-cost session probe.
- `docs/adr/archived/ADR-020-onboarding-and-setup.md` — Phase 2 ("offer to install acpx; run it in-process; re-check") is retracted by Decision 1 here. The rest of ADR-020's preflight shape stands. Phase 4 (auth env) was already removed by ADR-022. Phase 3 (agent probing) is removed from init by Decision 3 here, moving to `doctor` only.
- `docs/adr/archived/ADR-019-coding-agent-agnostic.md` — open `AgentId: string`. The orchestrator fix (Decision 5) is the last piece of making ADR-019's contract real.
- `docs/adr/archived/ADR-003-agent-adapter-and-acpx.md` — Decisions 2 (shell-out) and 6 (version pin) stand unchanged.
- `src/setup/init.ts` — `maybeInstallAcpx` (lines 267-275) deleted (Decision 1). Re-probe block (lines 117-123) deleted (Decision 1). `maybeInstallAgent` (lines 277-291) deleted (Decision 2). `prompt`, `nonInteractive`, `yes` parameters removed (Decision 3). `printConfigPreview` removed (Decision 3). Merged prompt replaced with unconditional write (Decision 3).
- `src/setup/preflight.ts` — `checkAgentInstalled` (lines 205-224) deleted (Decision 2). `checkAgentHandshake` (lines 226-260) rewritten to use `sessions new` + `close` (Decision 2). `AgentCheckResult.installed` dropped (Decision 2). `AgentCheckResult` simplified (Decision 2).
- `src/setup/hints.ts` — `AGENT_INSTALL_HINTS` → full 19-row registry, `pkg` → `acpxCommand` (Decision 4).
- `src/daemon/orchestrator.ts:34,174,185` — `BUILDER_AGENT_ID` deleted, builder path via `resolveAgentId("builder")` (Decision 5).
- ACPX sources: `acpx.sh/CLI.html` (no `--list-agents`; `sessions new` is the documented create command; `exec` is the one-shot prompt command), `acpx.sh/agents.html` (built-in registry, the table in Decision 4), `docs.openclaw.ai/tools/acp-agents-setup` (OpenClaw's `agentId`-against-acpx pattern, `/acp doctor`). Referenced 2026-07-13, acpx 0.12.x.