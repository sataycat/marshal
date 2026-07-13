# ADR-022: Onboarding Preflight Revisions — Repo State vs. Global Config, and Drop Auth-Env Phase

## Status

Accepted — 2026-07-13. Implemented in `src/setup/` and moved to `docs/adr/archived/`.
Supersedes parts of ADR-020 (Decision 1 changes §1 / §"Phase 6"; Decision 2 drops §"Phase 4"; Decision 3 changes §4).

## Context

ADR-020 specified the `marshal init` preflight as six phases and shipped in `src/setup/init.ts` / `src/setup/preflight.ts`. Two issues surfaced from real first-run use:

### Issue A — ".marshal" is written even when the user declines "Write this config?"

Observed interaction:

```
— config preview (/Users/user/.marshal/config.json):
{ ... }
Write this config? [y/N] N
— config not written
...
✓ repo initialized at /Users/user/code/marshal/.marshal
```

The user replied `N` and yet `.marshal/` appeared on disk in the repo. Root cause, `src/setup/init.ts:127-157`:

- **Phase 5** (lines 134-151) prompts "Write this config?" and gates only `writeGlobalConfig(merged, configPath)` — i.e. only the _machine-level_ `~/.marshal/config.json`. On `N` it prints "config not written" and proceeds.
- **Phase 6** (lines 153-157) is annotated "always runs" and unconditionally calls `initGlobalConfig()` + `initRepoState(repoRoot)` + `openDb(repoRoot)`, which create `.marshal/` and `.marshal/state.db` inside the repo.

What the user declined (global config) and what got written (repo state dir) are two different things that are _both_ colloquially called "the config": `~/.marshal/config.json` and `.marshal/<repo state>`. ADR-020 §1 reinforces the collision by naming the machine-level directory `~/.marshal/` and the repo-level state `.marshal/`. The prompt copy — "Write this config?" — gives no hint that it's only about the machine file, and Phase 6's "always runs" guarantee was a deliberate ADR-020 choice that was correct on its own terms (idempotent, repo-local state is per-repo) but wrong as a UX outcome when the user just declined "set things up".

This is a trust bug. The user told the tool not to write; the tool wrote.

### Issue B — Provider auth env vars are surfaced as if they were Marshal dependencies

Phase 4 of `marshal init` / `marshal doctor` runs `checkAuthEnv` (`src/setup/preflight.ts:253-264`), which presence-checks `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` against Marshal's own process environment and prints, on absence:

```
⚠ opencode auth (missing OPENAI_API_KEY) — fix: export OPENAI_API_KEY=... — docs: https://platform.openai.com/api-keys
⚠ pi auth (missing ANTHROPIC_API_KEY) — fix: export ANTHROPIC_API_KEY=... — docs: https://console.anthropic.com/settings/keys
```

The mapping is encoded in `src/setup/hints.ts:24-29`:

```ts
export const AGENT_AUTH_ENV: Record<string, string[]> = {
  opencode: ["OPENAI_API_KEY"],
  pi: ["ANTHROPIC_API_KEY"],
  "claude-code": ["ANTHROPIC_API_KEY"],
  codex: ["OPENAI_API_KEY"],
};
```

The shape and the message treat provider API keys as a Marshal-side dependency. They are not. Per ADR-003 §"Auth", the spawn contract is:

> ambient provider env vars (`OPENAI_API_KEY`, etc.) are inherited by child agents; ACP `authenticate` handshakes use `ACPX_AUTH_<METHOD_ID>` env vars or `auth` config entries. For M0 we rely on ambient env vars plus each agent's own config.

Marshal never reads, parses, validates, or names those keys. The child `acpx <agent>` process and the agent CLI it wraps do. By special-casing `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` from `init`/`doctor`, Marshal:

1. **Leaks the abstraction.** It makes a local-first orchestrator appear to be an OpenAI/Anthropic client. New users reasonably conclude Marshal calls the providers directly.
2. **Is wrong by construction for several real configs.** Agents may read auth from `~/.config/<agent>/`, from `ACPX_AUTH_*` entries, from a proxy / gateway header, from a hosted endpoint, or under a different env var name. Phase 4 would silently pass (or silently warn) in those cases while the agent is actually fine, or vice versa.
3. **Duplicates Phase 3.** `checkAgentHandshake` (`src/setup/preflight.ts:216-245`) already performs a real ACP round-trip (`acpx <agent> exec --cwd /tmp 'hello' --timeout 15 --format quiet`) and on non-zero exit already warns "agent did not respond (likely auth)" and points to the agent's own docs. That probe is authoritative; Phase 4's env presence check is a guess that runs alongside the authoritative answer.
4. **Couples Marshal's code to provider specifics.** As written, ADR-019's "coding-agent-agnostic" contract only holds at runtime. The onboarding surface silently contradicts it: the moment a user picks an agent family that isn't in `AGENT_AUTH_ENV`, Phase 4 prints "Unknown agent — ensure its auth is configured per its docs" while Phase 3 has already said something useful. The hint table is advisory for install hints (ADR-020 §3) but here it's been used to hardcode auth-env knowledge.

### Design constraints

- **Do not regress the idempotent / fast re-run property** (ADR-020 §1, §"Repeat use is fast"). Whatever the new behavior is, a second repo on an already-configured machine is still near-instant.
- **Do not soften auth diagnosis.** The actual diagnostic for "can this agent run" is the ACP handshake (Phase 3). Dropping Phase 4 must not produce a worse signal — it should produce a _better_ one, because we stop emitting a warning that can be both false-positive and false-negative.
- **Preserve `marshal doctor` as read-only.** Its contract is unchanged: run checks, mutate nothing.
- **Preserve the open agent-ID model (ADR-019).** No new hardcoded `AGENT_AUTH_ENV` table, no new hardcoded provider env names.
- **No new runtime dependencies.** Same shell-out-to-PATH approach.

## Decisions

### 1. Merge Phase 5 and Phase 6 into a single, honest "Write this config?" prompt

Today Phase 5 (global config write) and Phase 6 (repo state init) are separate, and Phase 6 is unconditional. They should be one user-visible step.

**Decision: `marshal init` asks the user once, towards the end of the preflight, "Initialize Marshal in this repo?"[1] That single `y/N` governs both writing `~/.marshal/config.json` (when not already present / when a merge is proposed) and creating `.marshal/state.db` + the repo state dir.**

Concretely, in `runInit`:

When machine-level config would be written _or_ the repo is not yet initialized, prompt exactly once. If the user declines: print a single line ("— initialization skipped; no files written") and exit zero _without_ creating `.marshal/`. If the user accepts: write the global config (if generated), then run Phase 6 as before.

Notes:

- **The previous "always runs" guarantee for Phase 6 is dropped.** This is the explicit behavior change. Rationale: ADR-020 \u2019s idempotent re-run speed win is real but minor (one fast sqlite open); it is not worth overruling a user's explicit `N`. On already-initialized repos, the prompt is skipped entirely and Phase 6 runs as before (it's `initRepoState`'s idempotent create-if-missing), so the "fast re-run" property is preserved where it actually matters — when the repo is already initialized.
- **Machine-already-configured fast path (lines 70-77) is unchanged.** When `machineAlreadyConfigured(configPath)` is true, no prompt is issued and Phase 6 runs unconditionally — that path never shows "Write this config?", so there is no prompt to honor, and creating repo state silently is correct.
- **`--non-interactive` keeps today's semantics: write nothing for the global config, write repo state only if `MARSHAL_INIT_REPO_FORCE=1`[2], exit non-zero if anything is missing.** See Decision 3.
- The prompt copy changes from "Write this config?" to "Initialize Marshal in this repo (writes ~/.marshal/config.json and .marshal/state.db)?" so the two write targets are explicit.

[1] Final copy TBD; the requirement is that the prompt text makes the two write targets visible in one line.
[2] Exact env switch name is an implementation detail; the point is that CI gets an explicit opt-in before any file is touched on a brand-new repo.

### 2. Remove auth-env presence checks from preflight; keep only the handshake probe

**Decision: Phase 4 ("Auth environment") as specified in ADR-020 §Phase 4 and implemented by `checkAuthEnv` is removed.** The authoritative "can this agent run" check is the ACP handshake probe in Phase 3 (`checkAgentHandshake`), which already:

- performs a real round-trip to the agent (`acpx <agent> exec ... 'hello'`),
- classifies non-zero exit as "likely auth" and points to the agent's own docs,
- works for any agent ID, not just the curated four, because it doesn't consult an `AGENT_AUTH_ENV` table.

Implementation changes in `src/setup/`:

- Delete `checkAuthEnv` from `preflight.ts` and the `AGENT_AUTH_ENV` + `PROVIDER_KEY_LINKS` exports from `hints.ts`.
- Delete the Phase 4 loop in `init.ts` (lines 118-125) and the matching loop in `runDoctor` (`preflight.ts:262-267`).
- Update the corresponding tests in `init.test.ts` / `preflight.test.ts` to assert that no `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` strings appear in `init` / `doctor` output.
- `AGENT_INSTALL_HINTS` stays — it's advisory install guidance for Phase 3, not auth advice, and is correctly attributed (ADR-020 §3).

**Improve, don't weaken, the handshake failure message.** Today it says "agent did not respond (likely auth)" and links to a generic docs fragment. After the removal it becomes the _only_ auth signal, so tighten it to surface the agent's own stderr/stdout verbatim (already done at lines 239-241) and link to the per-agent `docs` from `AGENT_INSTALL_HINTS` when known, else to ACPX docs. The point is: the diagnostic ownership stays with the agent and ACPX, where it belongs; Marshal never names a provider env var.

### 3. Tighten `--non-interactive` so it writes nothing without an explicit opt-in

Today `--non-interactive` skips the prompts but Phase 6 still runs unconditionally, which means `marshal init --non-interactive` in CI silently creates `.marshal/` in a fresh repo. The behavior change in Decision 1 implies the same fix here:

**Decision: `marshal init --non-interactive` writes no files unless `--yes` (or `MARSHAL_INIT_YES=1`) is passed.** `--yes` is the explicit consent for both global config and repo state. `--non-interactive --yes` reproduces today's "no prompts, write repo state + global config if generated" behavior. `--non-interactive` alone writes nothing and exits zero if all checks pass, non-zero if any fail — useful for "validate the environment without mutating the repo" in CI.

## Consequences

- **Saying `N` to `marshal init` no longer mutates disk state.** Decision 1 closes the trust bug. The cost is one extra prompt on first-repo onboarding (previously implicit; now explicit in the merged prompt) and the loss of the "Phase 6 always runs" guarantee — judged acceptable because `.marshal` on a fresh repo is the only case where this matters; subsequent inits already take the machine-already-configured fast path.
- **Preflight output no longer mentions `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`.** The orchestrator stops appearing to be a provider client. Auth diagnosis becomes the handshake probe's responsibility, which is more accurate: it tests the actual code path the runtime uses, with no Marshal-side guessing about env var names. A user whose auth is configured via `~/.config/opencode/auth.json` (not env) stops getting false warnings, and a user whose `OPENAI_API_KEY` is set but expired stops getting false reassurance.
- **ADR-019 (coding-agent-agnostic) now extends to onboarding.** Previously only the adapter respected the open agent-ID contract; `init`/`doctor` quietly contradicted it via `AGENT_AUTH_ENV`. With that table gone, adding a new agent only needs `AGENT_INSTALL_HINTS` (a pure install-hint convenience, optional). Unknown agents get the same handshake probe and the same "install manually" fallback as today.
- **`marshal doctor` becomes purely about reachability.** Role install hint + ACPX + node/git/pnpm + ACP handshake + config-present. No provider env diagnostics. Simpler output, fewer false alarms.
- **Tests change.** `preflight.test.ts:196-202` asserts behavior of `checkAuthEnv`; those tests are deleted along with the function. `init.test.ts` env tests need updating: the `env: { OPENAI_API_KEY: "sk-x", ANTHROPIC_API_KEY: "sk-y" }` injection in `init.test.ts:81,122,202` was only there to satisfy Phase 4 — it can be dropped. New tests assert that no provider env var name appears in `init`/`doctor` stdout, and that the merged prompt gates _both_ writes.
- **Document contract for `acpx <agent> exec 'hello'`.** This probe now carries all auth diagnosis. We rely on ACPX's `exec hello` returning non-zero on auth failure and a readable stderr, as it already does today. If a future ACPX release changes that contract, the preflight degrades to "agent not reachable" warnings — still strictly better than today's false-positive env presence check. We keep the pinned ACPX version range (ADR-020 §Phase 2) to avoid drift.

## Open questions (deferred)

- **Should `doctor` offer a more invasive connectivity probe** (e.g., a real short prompt handshake, not just `exec hello`)? Deferred — `exec hello` is the cheapest non-mutating probe and matches ACPX's documented one-shot pattern.
- **Should the merged prompt offer a split ("write global config only" vs "write repo state only")?** No — that re-introduces the "which one do I run" decision ADR-020 §1 closed. One prompt, two write targets, single `y/N`.
- **Web-based setup wizard.** Inherits from ADR-020's deferred open question. Whatever the web path does, it should also follow Decision 2 (no provider env presence checks) so CLI and web don't diverge.

## Related

- `docs/adr/archived/ADR-020-onboarding-and-setup.md` — the onboarding ADR this revises. Decision 1 here changes §1 / §"Phase 6"; Decision 2 here drops §"Phase 4"; Decision 3 here changes §4.
- `docs/adr/archived/ADR-003-agent-adapter-and-acpx.md` — §"Auth" is the source of the spawn contract: ambient env vars are inherited by child agents; Marshal itself does not own provider auth.
- `docs/adr/archived/ADR-019-coding-agent-agnostic.md` — the open agent-ID model. Decision 2 extends it from runtime to onboarding.
- `src/setup/init.ts` — `runInit`, Phases 5-6 (`lines 127-166`), `runDoctor` (lines 233-279).
- `src/setup/preflight.ts` — `checkAuthEnv` (lines 253-264), `checkAgentHandshake` (lines 216-245).
- `src/setup/hints.ts` — `AGENT_AUTH_ENV`, `PROVIDER_KEY_LINKS` (to be deleted); `AGENT_INSTALL_HINTS` (kept).
- `src/setup/init.test.ts`, `src/setup/preflight.test.ts` — tests requiring updates per Consequences.
