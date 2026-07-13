# ADR-023: ACPX as the Single Agent Substrate

## Status

Proposed — 2026-07-13. Supersedes ADR-003 Decisions 2, 6, and 7; supersedes the *stance* of PROJECT.md §4 and §3.3 (which ADR-003 also superseded in part). Builds on ADR-019 (open `AgentId: string`).

## Context

ADR-019 closed the obvious gap in ADR-003 by widening `AgentId` to `string` and deleting the `VALID_AGENT_IDS` allowlist. But ADR-019 kept the **`opencode`/`pi` per-role defaults** (`builder → opencode`, `validator → pi`, `specAuthor → opencode`) and ADR-003's framing survived everywhere else: ACPX as a *fragile alpha* Marshal might have to replace, the `opencode`+`pi` pair as Marshal's identity, and a hand-curated 4-entry install-hint table.

Three things make that stance obsolete in 2026-07:

1. **ACPX now publishes a stability commitment.** The `acpx.sh/VISION` page (referenced 2026-07-13) explicitly designates ACPX as a reusable backend for orchestrators that "do not want to own session persistence, queue ownership, prompt serialization, adapter process management, permission policy behavior, or harness-specific operational details." Principle 4 ("Conventions are API surface") commits the CLI grammar, flag names, output shapes, and the "hard rule: no acpx-specific event envelope, no synthetic `type`/`stream` wrapper fields" to long-term stability. A 0.12.x → 0.13.x bump is no longer a "couple the core to alpha internals" event; it is a versioned API change against a published contract.
2. **The agent roster is not 4 agents.** ACPX's built-in registry (`acpx.sh/agents.html`) maps ~20 friendly names to ACP adapter commands — `pi`, `openclaw`, `codex`, `claude`, `gemini`, `cursor`, `copilot`, `droid`, `fast-agent`, `grok-build`, `iflow`, `kilocode`, `kimi`, `kiro`, `mux`, `opencode`, `qoder`, `qwen`, `trae` — with `--agent <command>` as the escape hatch for anything else. The Registry also smooths per-agent rough edges: `--system-prompt` is "claude-family only, other adapters ignore" (per-agent docs); `qoder`'s `--max-turns` and `--allowed-tools` are forwarded into Qoder CLI startup flags; `codex`'s `--model` flows through `session/set_config_option`. Every built-in supports the common command surface (`prompt`, `exec`, `cancel`, `set-mode`, `set`, `status`, `sessions …`).
3. **The current code is internally inconsistent about who picks the agent.** ADR-019 made `resolveAgentId(role)` the single source of truth, but `src/daemon/orchestrator.ts:34` still hard-codes `const BUILDER_AGENT_ID = "opencode" as const;` and bypasses `resolveAgentId("builder")` on the builder path (`orchestrator.ts:174,185`). The validator path already calls `resolveAgentId("validator")` (`orchestrator.ts:346`). So configuring `agents.builder: "codex"` in `~/.marshal/config.json` *silently does nothing* today. That is a regression vs. ADR-019's stated contract, not a future feature.

Meanwhile Marshal's identity has nothing to do with `opencode` or `pi`. PROJECT.md §3.3 calls ACP "**durable, multi-vendor, 25+ agents**" and Tenet 2 says "Supported-agent count becomes a function of protocol coverage, not our labor." Treating any one agent as the default star of Marshal contradicts the project's own thesis. The defaults were pragmatic scaffolding for M0 ("prove the loop on two agents first"); with ACPX's stability commitment, the scaffolding should come off.

## Decisions

### 1. ACPX is Marshal's sole agent substrate; no parallel direct-ACP adapter

ADR-003 Decision 2 ("shell out to the `acpx` binary, parse NDJSON") stays. ADR-003's fallback posture ("if ACPX churns, implement the same interface directly against ACP JSON-RPC; ACPX becomes reference, not dependency") is **retracted**. Marshal does not maintain a direct-ACP adapter; we treat ACPX like any other infrastructure dependency (a pinned semver range against a stability-committed CLI), and breakage is fixed forward in the adapter, not by switching substrates.

Rationale: ACPX's VISION explicitly names Marshal-shaped orchestrators as its primary user and commits the surface we depend on. Maintaining a parallel adapter against raw ACP JSON-RPC would duplicate ACPX's session persistence, queueing, lifecycle, and per-agent smoothing — the work ACPX exists to do. If ACPX ever does break badly enough to consider leaving, the break will be visible (semver bump, version-pin check fires) and a fallback can be written then. Carrying the fallback now is speculative work against a contract that just got a stability promise.

The `Agent` interface in `src/agent/types.ts` is **kept unchanged**. It is a clean anti-corruption layer around the *CLI* contract (not the ACP wire contract), and keeping it means tests still run against a fake `acpx` shim without touching real agents. The interface isolates us from `acpx` *CLI* churn — flag renames, NDJSON field additions — without forcing us off ACPX.

### 2. All three roles resolve their agent id the same way; the orchestrator stops hard-coding `opencode`

`src/daemon/orchestrator.ts:34,174,185` — delete `BUILDER_AGENT_ID` and route through `resolveAgentId("builder")` exactly as the validator already does. `runLog.startRun(task.id, "builder", builderAgentId, prompt)` and `agent.spawn(worktree.path, builderAgentId, spawnOpts)` use the resolved id. The build run log records whichever agent the user configured, not a constant.

Document the contract in one place — `resolveAgentId(role)` in `src/worktree/config.ts` is the only place that knows the agent id, and every caller (orchestrator, spec-chat, HTTP) goes through it. A grep audit confirms three call sites: `orchestrator.ts:346` (validator), `http.ts:628` (specAuthor), `spec-chat.ts:172` (fallback default) — the last two already resolve; the builder call site is the regression.

### 3. Per-role defaults are removed; `agents.{builder,validator,specAuthor}` are required at first real use

`AGENT_ID_DEFAULTS` in `src/worktree/config.ts:63-67` is deleted. `resolveAgentId(role)` returns the configured string or throws `MissingAgentIdError(role)` with a message that names the config key and points at `acpx.sh/agents.html`:

```
No agent configured for role "builder". Set ~/.marshal/config.json →
agents.builder to any acpx agent (see https://acpx.sh/agents.html), e.g.:
  { "agents": { "builder": "codex", "validator": "claude", "specAuthor": "opencode" } }
```

`specAuthor` no longer falls back to `builder` silently either — if it's missing, it throws with the same shape (pointing the user at the `specAuthor` key). The implicit "specAuthor = builder" convenience from ADR-019 becomes explicit: `marshal init` writes `specAuthor` into the config (next decision), and a hand-authored config that omits it is told exactly what to add.

Rationale: defaults are *opinions Marshal should not have*. The moment we ship `builder → opencode` as a default, users assume Marshal is "the opencode runner" and new users copy the default rather than choosing. Making the choice explicit at init time — and failing loudly if someone deletes the key — keeps Marshal genuinely agent-agnostic. This also fixes the long-standing ADR-003/ADR-019 contradiction where the docs said "any agent is one config line away" while the code shipped with two specific agents hardcoded as defaults.

### 4. `marshal init` helps the user choose; it does not pick a default for them

`src/setup/init.ts` Phase 3 today resolves `resolveAgentId("builder")` and `resolveAgentId("validator")` *from any existing config* — which under this ADR means it requires those keys to exist before Phase 3 runs. The flow becomes:

1. If the user's `~/.marshal/config.json` already has `agents.{builder,validator}` (and ideally `specAuthor`), init uses them unchanged (the existing-config fast path is preserved).
2. If those keys are missing, init runs an interactive chooser:
   - Probe a curated candidate list using the existing `checkAgentHandshake` probe (`src/setup/preflight.ts:216`). Candidates are the ACPX built-in registry (Decision 5) intersected with "the handshake responded ok/warn on this machine." This reuses the existing probe machinery; ADR-022's stance ("handshake is the authoritative can-this-agent-run signal") is unchanged.
   - Print one line per available agent: `  [1] codex    ✓ handshake ok`. Agents that fail to install (`acpx <id> --version` non-zero) or whose handshake fails (auth missing) are shown with `✗` and the ACPX docs link, but are still selectable — the user may want to configure them and fix auth later.
   - Prompt separately for builder, validator, and specAuthor (with specAuthor defaulting to whatever the user picked for builder *in the interactive prompt*, not at resolution time — i.e. the chosen value is written into the config, not silently inherited).
3. `--non-interactive` without an existing config: init writes a config that references the *first handshake-OK candidate* for each role, with a clear stdout line ("non-interactive mode: chose `codex` for builder based on the first successful ACP handshake probe; override via `~/.marshal/config.json`"). If zero candidates handshake-OK, init fails with the existing "no working agent" message and refuses to write a config (you can't run Marshal without an agent, and we won't fake one with a default).
4. The generated config (`src/setup/preflight.ts:generateConfig`) is extended to write `agents.specAuthor` so the post-init state is complete and `resolveAgentId("specAuthor")` never throws on a fresh install.

### 5. `AGENT_INSTALL_HINTS` becomes the full ACPX built-in registry

`src/setup/hints.ts:17-25` today has 4 entries (`opencode`, `pi`, `claude-code`, `codex`) and uses wrong upstream identifiers (`@anthropic-ai/claude-code-acp` is not the package ACPX runs; ACPX runs `@agentclientprotocol/claude-agent-acp`). The table is replaced with the ACPX built-in registry verbatim from `acpx.sh/agents.html`:

```ts
export const AGENT_INSTALL_HINTS: Record<string, AgentInstallHint> = {
  pi:          { acpxCommand: "npx pi-acp",                          docs: "https://github.com/mariozechner/pi" },
  openclaw:    { acpxCommand: "openclaw acp",                       docs: "https://github.com/openclaw/openclaw" },
  codex:       { acpxCommand: "npx -y @agentclientprotocol/codex-acp",       docs: "https://codex.openai.com" },
  claude:      { acpxCommand: "npx -y @agentclientprotocol/claude-agent-acp", docs: "https://docs.anthropic.com/claude-code" },
  gemini:      { acpxCommand: "gemini --acp",                        docs: "https://github.com/google/gemini-cli" },
  cursor:      { acpxCommand: "cursor-agent acp",                    docs: "https://cursor.com/docs/cli/acp" },
  copilot:     { acpxCommand: "copilot --acp --stdio",               docs: "https://docs.github.com/copilot/how-tos/copilot-chat/use-copilot-chat-in-the-command-line" },
  droid:       { acpxCommand: "droid exec --output-format acp",      docs: "https://www.factory.ai" },
  "fast-agent":{ acpxCommand: "uvx fast-agent-mcp acp",              docs: "https://fast-agent.ai/" },
  "grok-build":{ acpxCommand: "grok agent stdio",                    docs: "https://docs.x.ai/build/overview" },
  iflow:       { acpxCommand: "iflow --experimental-acp",           docs: "https://github.com/iflow-ai/iflow-cli" },
  kilocode:    { acpxCommand: "npx -y @kilocode/cli acp",            docs: "https://kilocode.ai" },
  kimi:        { acpxCommand: "kimi acp",                            docs: "https://github.com/MoonshotAI/kimi-cli" },
  kiro:        { acpxCommand: "kiro-cli-chat acp",                  docs: "https://kiro.dev" },
  mux:         { acpxCommand: "npx -y mux@^0.27.0 acp",              docs: "https://mux.coder.com" },
  opencode:    { acpxCommand: "npx -y opencode-ai acp",             docs: "https://opencode.ai" },
  qoder:       { acpxCommand: "qodercli --acp",                      docs: "https://docs.qoder.com/cli/acp" },
  qwen:        { acpxCommand: "qwen --acp",                           docs: "https://github.com/QwenLM/qwen-code" },
  trae:        { acpxCommand: "traecli acp serve",                   docs: "https://docs.trae.cn/cli" },
};
```

The `pkg` field is renamed to `acpxCommand` so the hint reflects what ACPX actually runs (and so the diagnostic line can show the exact adapter command, which is what the user needs to debug a missing binary). The handshake probe uses this table to render the chooser in Decision 4. Agents not in this table are still usable — `AgentId` is `string` (ADR-019) — but `init` falls back to "install manually per your agent's docs" wording (the existing fallback path) and a generic ACPX docs link for unknown ids.

`factory-droid`/`factorydroid` aliases are not enumerated separately; `init`'s probe uses the canonical `droid` token and the user can type the alias into the config by hand if they want (ACPX resolves both to the same adapter).

### 6. The ACPX version pin stays, but its rationale changes

`src/agent/acpx-adapter.ts:17` (`DEFAULT_VERSION_RANGE = ">=0.12.0 <0.13.0"`) and the startup version check (`AcpxAgentAdapter.ensureVersion`) are kept unchanged in behavior. The doc comment changes: the pin exists **because ACPX's CLI grammar and NDJSON shape are now Marshal's versioned API contract per the VISION's Principle 4**, not because we expect ACPX to break. A minor-bump warning stays a warning (not a hard fail) for the same reason it always did: a 0.12 → 0.13 bump on a stability-committed CLI is a normal semver transition, not an emergency, but the daemon should still log it loudly so an operator notices before a subtle flag rename bites them.

The `acpxNotInstalledError` message in `acpx-adapter.ts:269-273` is updated from "see docs/adr/ADR-003.md" to "see docs/adr/ADR-023.md" (the ADR that resets the relationship).

### 7. Tests pin the new contract; existing tests that hard-coded `opencode`/`pi` are updated

The grep audit finds ~25 `opencode`/`pi` literals in tests (`src/agent/acpx-adapter.test.ts`, `src/setup/init.test.ts`, `src/daemon/loop.test.ts`, `src/daemon/runs-api.test.ts`, `src/tasks/commands.test.ts`). They fall into three buckets:

- **Adapter unit tests** (`acpx-adapter.test.ts`) — the literal `"opencode"` is just a positional token for the stub `acpx` shim; it works equally well as `"codex"` or `"claude"`. Add a parametrized case that runs the spawn/prompt/cancel/close round-trip with `"codex"` and `"claude"` to pin the pass-through contract from ADR-019 decision 3 against regressions like the orchestrator's hard-coded `BUILDER_AGENT_ID`.
- **Loop/orchestrator tests** (`loop.test.ts`, `runs-api.test.ts`, `commands.test.ts`) — the `agentId: "opencode"` assertions are checking that the *configured* agent flows through. Keep them but add a sibling assertion that the orchestrator's builder call uses `resolveAgentId("builder")`'s return value, not a constant. This is the regression test for Decision 2.
- **Init/preflight tests** (`init.test.ts`, `preflight.test.ts`) — the `agents: { builder: "opencode", validator: "pi" }` defaults in test fixtures are updated to whichever agents the test is actually probing (or the test is moved to construct the config explicitly). The `init.test.ts:142` case (`{ builder: "claude-code" }` survives) is exactly the contract this ADR enforces and stays. The "defaults opencode/pi" assertions in `init.test.ts:164,198,322,349` are deleted or inverted: after init, the config should reflect *the user's choice* (interactive prompt stub) or the *first handshake-OK candidate* (non-interactive), not a hard-coded default.

New test: `src/worktree/config.test.ts` asserts that `resolveAgentId("builder", {})` throws `MissingAgentIdError` with a message containing `agents.builder` and `acpx.sh/agents.html`, and that `resolveAgentId("builder", { agents: { builder: "codex" } })` returns `"codex"`.

### 8. PROJECT.md and ADR-003 doc edits

PROJECT.md §3.3 ("Starting agents: opencode as builder, pi as validator") is rewritten to: "Starting agents: chosen by the user at `marshal init` time. Marshal ships no preferred agent; any agent in the ACPX built-in registry (`acpx.sh/agents.html`) or any custom `--agent <command>` works." The "OC/Codex/Gemini are adapter-wrapped rather than native ACP, so expect occasional adapter lag" line stays as a footnote but is reframed as a property of the upstream adapters, not a reason for Marshal to defer supporting them.

PROJECT.md §4 ("ACPX is alpha and its CLI/runtime interfaces are expected to change") is rewritten to: "ACPX publishes a stability commitment for its CLI grammar, flag names, output shapes, and the no-envelope NDJSON stream (`acpx.sh/VISION.html` Principle 4). Marshal pins a semver range and treats ACPX as a versioned infrastructure dependency, not as experimental scaffolding." The "If ACPX dies, implement the same interface directly against ACP" line is removed per Decision 1.

ADR-003 is already in `docs/adr/archived/`. A note is prepended to its Status line: "Superseded in part by ADR-019 (open `AgentId`) and ADR-023 (ACPX-as-sole-substrate, no defaults). Decisions 2, 6, and 7 are retracted by ADR-023; Decisions 1, 3, 4, 5 stand." No content is rewritten — archived ADRs are historical record.

## Consequences

- **Marshal stops having an opinion about which agent you run.** Configure `codex` as builder and `gemini` as validator, or `claude` for both, or the raw `--agent` token for something ACPX doesn't know about — the orchestrator, run log, gate, and board don't care. The project's tagline (Tenet 2: "agent-agnostic via ACP") becomes true at the defaults layer, not just at the type layer.
- **One regression fixed.** The hard-coded `BUILDER_AGENT_ID = "opencode"` in `orchestrator.ts:34` is the bug ADR-019 *should* have caught and didn't. This ADR makes the fix explicit and adds the regression test (Decision 7).
- **`marshal init` gets mildly slower and definitely more useful.** Probing ~20 agents' `--version` and one handshake each is on the order of seconds (mostly npx fetches that are cached after first run). The chooser is interactive, can be skipped with a pre-existing config, and in `--non-interactive` mode picks a working agent deterministically instead of assuming `opencode`/`pi` are installed.
- **No more silent `specAuthor = builder` fallback.** ADR-019's convenience inheritance becomes a documented init-time choice. If you write `~/.marshal/config.json` by hand and omit `specAuthor`, you get an explicit error pointing at the key, not a guess.
- **The version pin carries weight it didn't before.** With no fallback adapter, an ACPX 0.13 release that breaks the NDJSON shape is a Marshal bug, not a "switch to direct ACP" event. The pin range stays narrow (`>=0.12.0 <0.13.0`) and bumping it is a deliberate ADR-worthy decision, not a package.json sweep. The startup warning on mismatch is unchanged.
- **Install hints are now a 19-row table instead of 4.** Maintenance cost: someone has to refresh `hints.ts` when ACPX adds or removes a built-in. Mitigation: the hints are advisory (the handshake probe is authoritative per ADR-022), so an out-of-date hint degrades to "install manually per your agent's docs" — no correctness impact. A future slice could parse `acpx.sh/agents.html` at build time; not in scope here.
- **`MissingAgentIdError` is a new exported error.** External callers that constructed a `GlobalConfig` programmatically and relied on the `opencode`/`pi` defaults now get a thrown error. There are no such external callers in this repo (the audit covers `src/`); the CLI and HTTP layers both go through `resolveAgentId` at first real use, not at boot, so the daemon starts fine without a config and only fails when a task actually tries to build.

## Open questions (deferred)

- **Per-agent prompt templates.** ADR-019 already deferred this; this ADR makes it more urgent (a `grok-build` builder may need different prompt framing than a `codex` builder), but the answer is still "see what breaks, then add a template registry" — not something to spec ahead of evidence.
- **Per-agent permission/timeout defaults.** ADR-003 Decision 4 left the validator's tighter permission posture as a future knob. With 19 candidate agents, the right default for a review-only validator may be `--deny-all --no-terminal` regardless of agent, or it may need to be agent-specific (e.g. an agent that doesn't advertise the terminal capability anyway). Defer until a non-default validator is actually configured.
- **Auto-discovery vs. curated probe list.** Decision 4's chooser probes the curated `AGENT_INSTALL_HINTS` list. ACPX has no `--list-agents` command; the built-in registry is only documented, not queryable. If ACPX adds a registry query, the chooser should use it. Until then, the curated list is the best available source and matches what `acpx.sh/agents.html` publishes.
- **Decorrelated-builder-validator as a soft check.** Tenet 4 ("build with one model, validate with a different one, so the validator does not share the builder's blind spots") suggests `marshal init` should warn if the user picks the same agent id for both roles. This is a UX nicety, not correctness — the same agent under different model knobs (`--model`) may still be decorrelated — so it stays a warning in init, not a hard block.

## Related

- `docs/adr/archived/ADR-003-agent-adapter-and-acpx.md` — Decisions 2 (shell-out model), 6 (allowlist + version pin), 7 (timeouts). Decision 2's *mechanism* stands; its *fallback posture* is retracted here. Decision 6's allowlist was already deleted by ADR-019; the version-pin rationale is updated here. Decision 7 is unchanged.
- `docs/adr/archived/ADR-019-coding-agent-agnostic.md` — the open `AgentId: string`. This ADR completes it by also opening the *defaults* and the *init flow*.
- `docs/adr/archived/ADR-022-onboarding-preflight-revisions.md` — Decision 2 (handshake probe is authoritative, no env-var inspection). Decision 4 of this ADR reuses that probe unchanged.
- `docs/PROJECT.md` §3.3 (agent layer), §4 (anti-corruption layer) — rewritten per Decision 8.
- `src/agent/acpx-adapter.ts` — version-pin rationale comment update (Decision 6); error message ADR pointer update.
- `src/agent/types.ts` — unchanged (ADR-019 already widened `AgentId`).
- `src/worktree/config.ts` — `AGENT_ID_DEFAULTS` deletion, `MissingAgentIdError` addition, `resolveAgentId` throw-on-missing (Decisions 2, 3).
- `src/daemon/orchestrator.ts:34` — `BUILDER_AGENT_ID` deletion, builder-path resolution through `resolveAgentId("builder")` (Decision 2).
- `src/setup/hints.ts` — full ACPX registry (Decision 5).
- `src/setup/init.ts`, `src/setup/preflight.ts` — interactive chooser, no-defaults non-interactive path, `generateConfig` writes `specAuthor` (Decisions 4, 5).
- ACPX sources: `acpx.sh/VISION.html` (Principle 4, backend-friendly), `acpx.sh/agents.html` (built-in registry), `acpx.sh/CLI.html` (CLI grammar, exit codes, NDJSON contract). Referenced 2026-07-13, acpx 0.12.x.