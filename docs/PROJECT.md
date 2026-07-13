# Factory Harness — Design Doc

> Working title, name TBD. A local-first, agent-agnostic coding-agent orchestrator built around a "software factory" loop: human authors the spec, an agent builds autonomously in an isolated worktree, a dedicated verification gate validates, and the human reviews and merges.

Status: draft / pre-M0. Last updated: 2026-07-09.

---

## 1. Vision

A self-hosted control plane for driving coding agents through a build-verify-review loop with human-in-the-loop only at the two points where judgment matters: authoring the spec (front) and reviewing the merge (back). Everything in between runs unattended.

Spiritual successor to vibe kanban (Bloop shut down, project now community-maintained and uncertain), but the reason to exist is the part vibe kanban never had a strong opinion about: a first-class verification and validation gate. The board, worktrees, and PR flow are table stakes; the opinionated gate is the differentiator.

Deployment target is a single box or a VPS. Models are accessed via API (frontier or otherwise); "local" refers to the orchestration and verification running on infrastructure you control, not to local model weights.

## 2. Design tenets

1. Verification is the product. With the human out of the per-diff loop, the only thing preventing silent corruption is the gate. Build the gate before the autonomy.
2. Agent-agnostic via ACP. Target the Agent Client Protocol once instead of writing a bespoke adapter per agent. Supported-agent count becomes a function of protocol coverage, not our labor.
3. Minimize HITL to the two ends. Human owns the spec and the merge. The middle is unattended.
4. Decorrelated builder and validator. Build with one model, validate with a different one, so the validator does not share the builder's blind spots.
5. Incremental trust. Start HITL-heavy, remove human gates only as automated gates prove reliable. Auto-merge is earned per change-class, not granted up front.
6. Concurrency 1 to start. Worktrees solve file-level conflicts, not semantic ones. One task at a time sidesteps the one genuinely unsolved problem until the gate is strong enough to trust more.
7. Isolate the daemon from the clients. The backend owns all real state and work; clients are thin faces over one API.

## 3. Architecture

### 3.1 Headless core daemon (runs on the VPS)

Owns:

- Orchestrator — task lifecycle, state machine, failure routing.
- Worktree manager — one disposable git worktree/branch per task, cleaned up after.
- Agent layer — ACP client, via ACPX behind our own adapter interface (see 4).
- Validation runner — the verification gate, run in a separate worktree from the build.
- State — SQLite (tasks, sessions, run history, gate results).
- API — HTTP + WebSocket. This is the contract every client shares.

The daemon ships as an npm package installed independently of any repo (`npm i -g sataycat/marshal`). State is per-repo: the daemon manages a `.marshal/` directory in the repo root, and global config lives in `~/.marshal/`. State is discovered via cwd, same model as git — "one daemon per project" still composes on a VPS (run N daemons for N projects).

Process model — explicit decision: one daemon process per repo, not one global process multiplexing multiple repos. Each daemon instance binds its own port and writes it to `.marshal/daemon.port` on start; clients resolve the repo root (cwd-walk, same as git) and read that file to discover the daemon. This keeps the API contract simple — no repo-selector in every request — at the cost of N processes for N repos, which is acceptable on a single-box target (Section 1). A global config (`~/.marshal/config`) may specify a preferred port range; there is no global multiplexer.

### 3.2 Clients (thin, all talk to the daemon API)

- Web board — primary control surface. Kanban view, diff review with inline comments, merge.
- TUI — terminal-first control for the same API.
- VS Code panel (later, low priority) — a webview that calls the daemon API. Editor linkage is deprioritized; deep-link "open worktree in $EDITOR" covers the review case without embedding.

### 3.3 Agent layer

- Substrate: ACP (Agent Client Protocol, Zed's JSON-RPC over stdio standard). Durable, multi-vendor, 25+ agents, registry launched Jan 2026, remote transports on the roadmap.
- First client: ACPX (openclaw/acpx). Gives persistent + named sessions, prompt queueing, cancel, cwd sandboxing, permission modes, and structured typed output (thinking / tool calls / diffs). ACPX publishes a stability commitment for its CLI grammar, flag names, output shapes, and the no-envelope NDJSON stream (`acpx.sh/VISION.html` Principle 4); Marshal pins a semver range and treats ACPX as a versioned infrastructure dependency.
- Starting agents: chosen by the user at `marshal init` time. Marshal ships no preferred agent; any agent in the ACPX built-in registry (`acpx.sh/agents.html`) or any custom `--agent <command>` works.
- Note some agents are adapter-wrapped rather than native ACP, so expect occasional adapter lag; that is a property of the upstream adapters, not a reason for Marshal to defer supporting them.

### 3.4 Data and source of truth

Where content lives depends on its lifecycle phase:

- Project context (architecture, conventions, business case) — plain markdown in the repo (`AGENTS.md`, `PROJECT.md`, etc.). Version-controlled with the code, readable by any agent including standalone ones not in the marshal loop. Marshal does not own this; the repo does.
- Working spec (during authoring) — in SQLite. The spec-authoring surface is a grill-me chat UI where the human and an agent iterate conversationally before finalizing (see 7). Concurrent editing and WebSocket broadcast make SQLite the right home. A markdown render may exist but is a generated view, not source.
- Frozen spec (build contract) — committed markdown in the repo (`specs/NNNN-slug.md`, ADR-style). At the Ready transition the daemon renders the working spec to a file and commits it to the task branch. The builder's worktree is a checkout of that branch, so it sees the spec via git with no copying. Specs persist in main as institutional memory after merge.
- Kanban state, run history, gate results — SQLite. Pure state machine data and append-only logs.

The split maps to the board: authoring is collaborative and mutable (SQLite); the build run is contractual and immutable (committed file). The freeze at Ready is the only bridge between them.

## 4. Anti-corruption layer around ACPX

ACPX publishes a stability commitment for its CLI grammar, flag names, output shapes, and the no-envelope NDJSON stream (`acpx.sh/VISION.html` Principle 4). Marshal pins a semver range and treats ACPX as a versioned infrastructure dependency, not as experimental scaffolding.

- Define an internal Agent interface: spawn(cwd, agentId, opts?), prompt(session, text, opts?) returns AsyncIterable<AgentEvent>, cancel(session), close(session).
- ACPX sits behind one adapter implementing that interface.
- Pin the ACPX version. Review the npm postinstall hook (it fetches platform binaries) before trusting it on your box.

The risk is deliberately contained to one replaceable component sitting on top of a stable protocol. That, not any vendor's backing, is the safety story.

## 5. The loop

### 5.1 Board states

copy


Backlog / Spec -> Ready -> Building -> Validating -> Review -> Done

- Backlog / Spec — human drafts the task in a grill-me chat UI with an agent (see 7). Human owns the final acceptance criteria. Working spec lives in SQLite during this phase.
- Ready — human marks the spec frozen. Daemon renders it to a committed markdown file (see 3.4). Signals the orchestrator to pick it up.
- Building — orchestrator spins a worktree, runs the builder agent headless until the fast in-loop gates pass or a step budget is hit. The agent self-plans via its own todo tooling; there is no separate Plan board state — planning is internal to the build run, not a HITL checkpoint. Boundary test files (see Section 6) are frozen at the Ready transition alongside the spec (see Section 7); any diff produced during Building that modifies a frozen boundary test file is flagged and routed to human Review rather than allowed to auto-advance to Validating — editing the test instead of the code must not be a path to a passing gate.
- Validating — the boundary gate runs in a separate worktree with a different agent (the validator). Tests live in the repo; the builder can see them, but they are executed by the decorrelated validator.
- Review — human reviews the diff, comments, merges.
- Done — merged.

### 5.2 Failure routing (state machine)

- In-loop gate fails -> builder iterates in place until pass or step budget.
- Boundary gate fails -> bounce back to Building with the failure output as fresh context. Cap at N retries (start N = 2 or 3).
- Retry cap exceeded -> escalate to human (move to Review with a failure summary).
- Boundary gate passes + change-class is on the trusted auto-merge list -> auto-merge (later phases only).
- Boundary gate passes + change-class not trusted -> Review.

Spend ceiling — explicit non-functional requirement: every task carries a hard per-task spend ceiling in addition to the step budget. The ceiling is set at spec authoring time; a global default may be configured in `~/.marshal/config`. Steps can vary arbitrarily in token cost; the retry loop can compound spend further. The ceiling caps total dollar cost regardless of step count or step size. Reaching the ceiling before completion is treated identically to exceeding the retry cap — escalate to human Review with a cost-exceeded annotation. Cost is observable: the run history and gate results state in SQLite (Section 3.1) record cumulative spend per task, surfaced in the web board.

Concurrency capped at 1 initially.

### 5.3 Daemon crash recovery

If the daemon process dies while a task is in the Building or Validating state, the policy on restart is:

- The task is moved to Review with a "recovered after crash" annotation; no automatic retry is attempted.
- The worktree is preserved, not garbage-collected, for manual inspection.
- The in-flight agent process is considered orphaned and is not reattached; the operator re-queues manually.

This is the M0/M1 policy — intentionally conservative. SQLite WAL mode keeps the state database consistent across an unclean shutdown. Resume-from-checkpoint can be revisited once the gate is proven reliable; the policy must be stated explicitly rather than left undefined.

## 6. Verification and validation

Two levels, borrowed from the mainstream software-factory framing:

- In-loop (fast, cheap, deterministic): typecheck, lint, unit tests. Runs inside the builder's iteration. The builder can see and fix these.
- Boundary (comprehensive): integration and scenario tests, run in a separate disposable worktree after the build. The tests live in the repo — the builder can see them — but they are executed by the decorrelated validator, not the builder.

Decorrelated validator: the boundary gate uses a different model/agent than the build. This is the single highest-leverage design choice for "no mistakes" — a second model in a clean worktree, re-executing the full boundary test suite against the builder's diff, catches what the builder's blind spots miss.

Gate signal — explicit decision: the boundary gate's pass/fail MUST be the exit code and structured report from deterministic test execution, not free-form model judgment on whether the diff satisfies the spec. Tenet #1 ("verification is the product") holds only when the gate is deterministic and auditable. A future contributor who substitutes model judgment for test execution as the gating signal is knowingly violating this stated principle.

Advisory signal (non-gating): a narrative model-judgment signal (e.g., "does this diff look architecturally sound?") may be added as a separate, explicitly-labeled advisory output surfaced to the human at Review — never conflated with the gate result and never used to advance or block task state automatically.

Boundary test files: the set of files constituting the boundary test suite. These are frozen at the Ready transition alongside the spec (see Section 7); spec and boundary tests freeze together as one atomic build contract. Any modification to frozen boundary test files during Building is a gate-integrity violation routed to human Review rather than allowed to auto-advance (see Section 5.1).

## 7. Spec authoring

- The spec-authoring surface is a grill-me chat UI: the human and an agent iterate on the spec conversationally, bouncing ideas and exploring before finalizing. The working spec lives in SQLite during this phase (concurrent editing, WebSocket broadcast).
- Human owns acceptance criteria. An agent may help draft the spec, but if the same agent writes and implements it, it will write a spec it already knows it can satisfy.
- Spec granularity constraint: a spec must be scoped to a single mergeable diff completable within the configured step and spend budgets, not a multi-day epic. With concurrency capped at 1 (tenet #6) on a single-box target, larger work must be decomposed into sequential tasks before authoring.
- At the Ready transition, the daemon freezes two artifacts as one atomic build contract: (a) the working spec, rendered to `specs/NNNN-slug.md` and committed to the task branch, and (b) the boundary test files (see Section 6) in their current repo state. Both freeze simultaneously. The builder reads the spec via git in its worktree. If the spec is wrong mid-build, that is a new build run — unfreeze, revise, re-freeze. Neither artifact can be modified during Building without triggering a gate-integrity violation (Section 5.1).
- Acceptance criteria in the spec map to the boundary gate's test suite (frozen at Ready alongside the spec, executed by the decorrelated validator).

## 8. Security and sandboxing

- ACP/ACPX and OpenClaw do NOT sandbox the harness. The agent runs on the host with its own CLI file/exec permissions, and headless runs need a permissive profile (e.g. approve-all) because there is no TTY to approve prompts. Running an approve-all agent bare on the host without isolation is therefore unsafe in any scenario where the agent can reach paths beyond the task worktree.
- Therefore isolation is our responsibility: run the builder inside a container or throwaway VM, scoped to the task worktree. Do not run approve-all agents bare on the host.
- Pin alpha dependencies; audit postinstall hooks; keep provider credentials out of the agent's blast radius where possible.
- Daemon API trust boundary — hard requirement: the daemon's HTTP + WebSocket API (Section 3.1) is an RCE-as-a-service surface — it can spawn processes with file/exec permissions on request. The daemon MUST bind to localhost only by default. Any exposure beyond localhost requires an authenticated tunnel (SSH port-forward, Tailscale, or equivalent) or token-based auth on all HTTP/WebSocket endpoints. An unauthenticated listener reachable beyond localhost is never acceptable, regardless of perceived network-level safety.

## 9. Dependencies and risk posture

| Component              | Role              | Risk                         | Mitigation                                                                                                                                 |
| ---------------------- | ----------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| ACP                    | agent protocol    | low (durable, multi-vendor)  | target directly as fallback                                                                                                                |
| ACPX                   | ACP client        | low (stability-committed)    | anti-corruption adapter, pin version                                                                                                       |
| builder agent          | builder           | low                          | swappable via ACP; chosen at init                                                                                                          |
| validator agent        | validator         | low                          | swappable via ACP; chosen at init                                                                                                          |
| wrapped-agent adapters | agent compat shim | med (upstream lag per agent) | prove loop on native-ACP agents first; treat wrapped agents as lower-trust until adapter maturity demonstrated (aligns with M3 sequencing) |
| git worktrees          | isolation         | low                          | standard                                                                                                                                   |
| SQLite                 | state             | low                          | standard                                                                                                                                   |

## 10. Build sequencing

- M0 — vertical slice / go-no-go. Daemon spawns the configured builder via the ACPX adapter on a Ready task, runs headless in a worktree to completion, hands the diff to the configured validator, and routes pass/fail through the state machine. No UI yet. This proves or kills the whole design.
- M1 — control plane. Kanban board (web), task state in SQLite, worktree lifecycle, PR creation and merge.
- M2 — the gate, first-class. Two-level verification, decorrelated validator, retry/escalation routing. This is the differentiator; invest here.
- M3 — more agents. claude, codex, gemini, kimi via ACP. Mostly config, not code.
- M4 — clients. TUI, optional VS Code webview panel. Editor deep-links.

## 11. Open questions

- Container vs VM for builder isolation on the VPS? (devcontainer is probably enough; VM if paranoid.)
- Auto-merge change-class taxonomy: which classes graduate first (docs, tests, pure refactors)?
- Use ACPX standalone and build our own orchestration. Decided in ADR-003; OpenClaw gateway is not adopted for M0.
- Naming.

## 12. Prior art and references

- vibe kanban (BloopAI) — the board/worktree/PR model; now community-maintained after Bloop's shutdown.
- no-mistakes (kunchenguid) — local git proxy that runs an AI validation pipeline in a disposable worktree and forwards a clean PR only after checks pass. The gate model to steal.
- ACPX / OpenClaw (openclaw org) — headless ACP client and agent gateway. Independent open source, not OpenAI-backed.
- ACP (Zed) — the agent-editor protocol standard; the durable substrate.
- opencode, pi — early executors used to prove the loop; any ACPX-supported agent is now a config choice.
