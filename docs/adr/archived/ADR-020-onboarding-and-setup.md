# ADR-020: Onboarding and Setup

## Status

Accepted — 2026-07-13 (implemented in `src/setup/`)

## Context

Today, getting Marshal running requires the user to manually:

1. Install `acpx` globally (`npm i -g acpx@latest`) — an alpha tool most developers have never heard of.
2. Install a builder agent CLI (`opencode`) and ensure it's ACP-compatible.
3. Install a validator agent CLI (`pi`) and ensure it's ACP-compatible.
4. Set up provider API keys (e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) in their environment so the agents can reach model endpoints.
5. Hand-author `~/.marshal/config.json` with correct agent IDs, version ranges, and policy settings.
6. Run `marshal init` in the target repo to create `.marshal/` and the SQLite database (`.marshal/state.db`, the only file this step produces).

None of these steps are discovered automatically. The current `marshal init` command (§`src/cli.ts:25–32`) creates the state directory and database, but does not check prerequisites, does not detect what's installed, and does not guide the user through configuration. The README lists the requirements, but a new user hitting their first `acpx is not installed` error after trying to run a task is a bad first experience.

ADR-003 chose to shell out to the `acpx` binary and ADR-019 opened the agent ID to any string. Both decisions are correct and unchanged by this ADR. The gap is that the **user-facing setup path** does not leverage either: it doesn't check for `acpx`, doesn't probe which agents are available, doesn't verify auth, and doesn't write a working config. This ADR fills that gap.

### Design constraints

- **No new runtime dependencies.** The preflight uses the tools already on PATH (`npm`/`npx`, `acpx`, agent CLIs). It does not bundle or vendor any of them.
- **Idempotent.** Running `marshal init` on an already-configured system (machine and/or repo) is a no-op that reports "all checks passed."
- **Non-destructive.** Existing `~/.marshal/config.json` values are preserved; the preflight only fills in missing keys or offers to update them interactively.
- **Offline-safe for checks.** Probing what's installed (`which`, `--version`) works offline. Auth verification (which hits model APIs) is clearly labeled as an optional online step.
- **CLI-first.** M0/M1 is headless/CLI. The onboarding surface is a single CLI command (`marshal init`). A web-based setup wizard is a future concern for M2+.
- **One command, not two.** There is no separate `marshal setup` distinct from `marshal init` — see Decision 1.

## Decisions

### 1. `marshal init` absorbs `setup` — one onboarding command, not two

Earlier drafts of this ADR introduced `marshal setup` as a new command sitting alongside the existing `marshal init`, with `setup` calling `init` at the end. In review this split proved to be an unnecessary distinction: the only thing `init` does today is create `.marshal/` and the SQLite database (`.marshal/state.db`) — two lines of code (`initRepoState()` + `openDb()`) — and it was never a complete onboarding path on its own. Keeping it as a separate public command just gave new users a "which one do I run?" decision with no real payoff.

**Decision: there is one command, `marshal init`.** It runs the full preflight (Phases 1–5 below) and then does what `init` does today (Phase 6: repo state dir + SQLite). `marshal setup` is dropped — it does not ship as a separate command or alias.

`marshal init` is scope-aware and idempotent across the two things it manages:

- **Machine-level state** (Phases 1–5: system prerequisites, `acpx`, agent CLIs, auth env vars, `~/.marshal/config.json`) is checked once and cached as "already configured." Re-running `init` in a second or third repo on the same machine skips straight past these phases with a single `✓ machine already configured` line instead of re-printing the full checklist — it does not re-run installs or re-prompt.
- **Repo-level state** (Phase 6: `.marshal/state.db`) always runs, since it's specific to the current repo.

This means: first repo on a new machine → full interactive preflight + repo init. Every repo after that on the same machine → an near-instant repo init, same command, no extra flags needed. Users who know what they're doing can still skip straight to a hand-authored `~/.marshal/config.json` — `init`'s machine-level phases are a no-op if that file already passes checks.

The command lives at `src/setup/` with its own module so the preflight logic doesn't bloat the daemon or adapter code; only the CLI verb (`marshal init`) changes, not the internal module boundary.

### 2. Preflight check phases

`marshal init` runs the following phases in order. Each phase reports a status line (✓ found / ✗ missing / ⚠ warning) and, where applicable, offers to fix the issue. Phases 1–5 are skipped (collapsed to one summary line) when machine-level state is already known good; Phase 6 always runs.

#### Phase 1: System prerequisites

| Check                   | How              | On failure                     |
| ----------------------- | ---------------- | ------------------------------ |
| Node.js ≥ ES2022 (v18+) | `node --version` | Error with install link.       |
| git available           | `git --version`  | Error — git is non-negotiable. |
| pnpm available          | `pnpm --version` | Warn; offer `npm i -g pnpm`.   |

#### Phase 2: ACPX

| Check            | How                                                   | On failure                                                    |
| ---------------- | ----------------------------------------------------- | ------------------------------------------------------------- |
| `acpx` on PATH   | `which acpx` or configured `acpx.bin`                 | Offer to install: `npm i -g acpx@<pinned>`.                   |
| Version in range | `acpx --version` vs pinned range (`>=0.12.0 <0.13.0`) | Warn with the expected range; offer `npm i -g acpx@<pinned>`. |

If the user consents to install, setup runs the install command, re-checks, and reports success/failure. The pinned version range comes from `DEFAULT_VERSION_RANGE` in `src/agent/acpx-adapter.ts` (currently `>=0.12.0 <0.13.0`).

#### Phase 3: Agent discovery

For each configured role (`builder`, `validator`), and falling back to defaults (`opencode`, `pi`) when unconfigured:

| Check                           | How                                                                                             | On failure                                                                                                                                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent CLI installed             | `acpx <agent> --version` (ACPX's built-in registry resolves the agent command and runs it)      | Offer to install the agent's npm package: `npm i -g opencode-ai` for opencode, `npm i -g @anthropic-ai/pi-acp` for pi, etc. For unknown agents, print the agent ID and ask the user to install it manually. |
| Agent responds to ACP handshake | `acpx <agent> exec --cwd /tmp 'hello' --timeout 15 --format quiet` (one-shot, no saved session) | Warn — likely an auth issue. Print the expected env var(s) and link to the agent's docs. Do not block setup; the user may configure auth later.                                                             |

A curated install hint table maps well-known agent IDs to their npm packages:

```ts
const AGENT_INSTALL_HINTS: Record<string, { pkg: string; docs: string }> = {
  opencode: { pkg: "opencode-ai", docs: "https://github.com/nicholasgriffintn/opencode" },
  pi: { pkg: "@anthropic-ai/pi-acp", docs: "https://github.com/anthropics/pi" },
  "claude-code": {
    pkg: "@anthropic-ai/claude-code-acp",
    docs: "https://docs.anthropic.com/claude-code",
  },
  codex: { pkg: "@openai/codex-acp", docs: "https://github.com/openai/codex" },
};
```

This table is advisory (used only by setup for install hints), not a runtime allowlist — ADR-019's pass-through contract is unchanged.

#### Phase 4: Auth environment

For each agent, check for the expected provider env var(s):

| Agent family            | Expected env vars   |
| ----------------------- | ------------------- |
| opencode (OpenAI-based) | `OPENAI_API_KEY`    |
| pi (Anthropic-based)    | `ANTHROPIC_API_KEY` |
| claude-code             | `ANTHROPIC_API_KEY` |
| codex                   | `OPENAI_API_KEY`    |

The check is presence-only (`process.env[key] !== undefined`), not validation — the key could be invalid, but its absence is a guaranteed failure. Missing keys produce a warning with a link to the provider's API key page, not a hard error.

For agents not in the curated table, this phase is skipped with a note: "Unknown agent '<id>' — ensure its auth is configured per its docs."

#### Phase 5: Config generation

If `~/.marshal/config.json` does not exist, setup generates one from the detected state:

```jsonc
{
  "acpx": {
    "bin": "acpx", // or the detected path
    "version": ">=0.12.0 <0.13.0",
  },
  "agents": {
    "builder": "opencode", // or user's choice
    "validator": "pi", // or user's choice
  },
  "policy": {
    "maxRetries": 2,
  },
}
```

If the file already exists, setup merges — filling in missing keys, leaving existing ones untouched. The user is shown the final config and asked to confirm before writing.

#### Phase 6: Repo init

Runs the existing `initGlobalConfig()` + `initRepoState()` + `openDb()` sequence (what `marshal init` does today). Creates `.marshal/` and the SQLite database (`.marshal/state.db`) — the only file this phase produces. This is the one phase that always runs, even when Phases 1–5 were skipped as already-configured.

Prints a final summary:

```
✓ acpx 0.12.1 (ok)
✓ builder: opencode (installed, auth ok)
✓ validator: pi (installed, auth ok)
✓ config written to ~/.marshal/config.json
✓ repo initialized at .marshal/

Marshal is ready. Create your first task:
  marshal task create --slug my-feature --title "My feature" --spec-file spec.md
```

### 3. `marshal doctor` — re-run checks without mutating anything

`marshal doctor` runs Phases 1–4 (checks only, no installs, no config writes, no repo init) and reports the status table. Useful for diagnosing a broken setup after an upgrade or environment change. It is a read-only command that never mutates state, and remains distinct from `init` for that reason — it's a different verb (diagnose vs. onboard), not a redundant one.

### 4. `--non-interactive` flag

`marshal init --non-interactive` runs all checks, skips all prompts (no auto-installs, no config writes), and exits with code 0 if all checks pass or code 1 if any check fails. Intended for CI, scripts, and automated environments. The output is the same status table, machine-parseable via `--format json` (future).

### 5. First-run nudge instead of an install-time hook

`marshal init` (or any command that needs config) detects a missing `~/.marshal/config.json` and prints "run `marshal init` to get started," then exits non-zero. We deliberately do **not** auto-run `init` from an npm `postinstall` script: postinstall hooks that prompt interactively or shell out to install other global tools are fragile and surprising, especially for a command that needs explicit user consent to install things (`acpx`, agent CLIs). First run of `marshal init` after `npm i -g marshal` (per ADR-021) is the one onboarding entry point; there is no separate first-install command to remember.

## Consequences

- **New users run one command** (`marshal init`) and get a working system, or a clear diagnosis of what's missing and how to fix it. There is no second command (`setup`) to discover or choose between.
- **Repeat use is fast.** Onboarding a second, third, etc. repo on an already-configured machine is a near-instant `init` run — Phases 1–5 collapse to one line, only Phase 6 (repo state dir + SQLite) does real work.
- **The anti-corruption boundary is preserved.** `init`'s preflight shells out to `acpx` and agent CLIs the same way the adapter does. It does not import ACPX internals or agent libraries. If ACPX dies, the preflight's checks die too — and that's correct, because the adapter would also be dead.
- **The curated install-hint table is not a runtime allowlist.** It lives in `src/setup/` and is only consulted during `init` and `doctor`. The adapter and config system remain fully open per ADR-019. Adding a new agent to the hint table is a one-line change; omitting one just means `init` says "install it manually."
- **Auth checks are best-effort.** Presence of an env var does not guarantee it's valid. The one-shot handshake probe in Phase 3 catches most auth failures, but `init` does not guarantee the first real build will succeed. The run log (ADR-006) and the daemon's error surfacing remain the definitive diagnostic path.
- **`marshal doctor` gives ongoing diagnostic value** beyond first-time onboarding — it's the answer to "my build suddenly fails, what changed?" (e.g., ACPX was upgraded past the pinned range, or an API key expired).

## Open questions (deferred)

- **Web-based setup wizard.** Once M1's web board exists, a setup/onboarding flow in the browser is natural. This ADR covers the CLI path only; the web path can reuse the same check functions.
- **Auto-update ACPX.** Setup could offer `npm update -g acpx` when a new version is detected. Deferred because auto-updating an alpha dependency in a security-sensitive tool (ADR-003 §"pin the version") needs more thought.
- **Per-repo agent overrides.** `marshal.json` could carry agent overrides per repo (e.g., this repo uses `claude-code` as builder). Currently agents are global config only. Setup would need to merge both. Deferred until the use case is concrete.
- **Agent auth token storage.** Today, API keys live in env vars. A future setup could offer to write them to a marshal-managed credential store (keychain, encrypted file). Deferred — env vars are the standard for M0/M1.

## Related

- `docs/PROJECT.md` §4 — anti-corruption layer (preserved, not changed).
- `docs/adr/archived/ADR-003-agent-adapter-and-acpx.md` — the ACPX integration model setup validates against.
- `docs/adr/archived/ADR-019-coding-agent-agnostic.md` — the open agent-ID model. Setup's hint table is advisory, not gating.
- `src/daemon/config.ts` — `initGlobalConfig()`, `initRepoState()` (called by `init`'s Phase 6).
- `src/worktree/config.ts` — `GlobalConfig` schema, `resolveAgentId()` (`init` reads/writes the same config shape).
- `src/agent/acpx-adapter.ts` — `DEFAULT_VERSION_RANGE`, `acpxNotInstalledError()` (`init` reuses the version range and improves on the error message).
