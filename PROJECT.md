# Factory Harness — Design Doc

> Working title, name TBD. A local-first, agent-agnostic coding-agent orchestrator built around a "software factory" loop: human authors the spec, an agent builds autonomously in an isolated worktree, a dedicated verification gate validates, and the human reviews and merges.

Status: draft / pre-M0. Last updated: 2026-07-06.

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

The daemon ships as a single binary installed independently of any repo (cargo install / brew / curl-install). State is per-repo: the daemon manages a `.marshal/` directory in the repo root, and global config lives in `~/.marshal/`. State is discovered via cwd, same model as git — "one daemon per project" still composes on a VPS (run N daemons for N projects).

### 3.2 Clients (thin, all talk to the daemon API)

- Web board — primary control surface. Kanban view, diff review with inline comments, merge.
- TUI — terminal-first control for the same API.
- VS Code panel (later, low priority) — a webview that calls the daemon API. Editor linkage is deprioritized; deep-link "open worktree in $EDITOR" covers the review case without embedding.

### 3.3 Agent layer

- Substrate: ACP (Agent Client Protocol, Zed's JSON-RPC over stdio standard). Durable, multi-vendor, 25+ agents, registry launched Jan 2026, remote transports on the roadmap.
- First client: ACPX (openclaw/acpx). Gives persistent + named sessions, prompt queueing, cancel, cwd sandboxing, permission modes, and structured typed output (thinking / tool calls / diffs). Alpha, so wrapped behind our interface (see 4).
- Starting agents: opencode as builder, pi as validator. Both have clean programmatic surfaces and ACPX adapters, and using two different lineages gives the decorrelated builder/validator split for free.
- Later agents (near-free via ACP): claude, codex, gemini, kimi. Note Claude Code and Codex are adapter-wrapped rather than native ACP, so expect occasional adapter lag;
that is a reason to prove the loop on opencode/pi first.

### 3.4 Data and source of truth

Where content lives depends on its lifecycle phase:

- Project context (architecture, conventions, business case) — plain markdown in the repo (`AGENTS.md`, `PROJECT.md`, etc.). Version-controlled with the code, readable by any agent including standalone ones not in the marshal loop. Marshal does not own this; the repo does.
- Working spec (during authoring) — in SQLite. The spec-authoring surface is a grill-me chat UI where the human and an agent iterate conversationally before finalizing (see 7). Concurrent editing and WebSocket broadcast make SQLite the right home. A markdown render may exist but is a generated view, not source.
- Frozen spec (build contract) — committed markdown in the repo (`specs/NNNN-slug.md`, ADR-style). At the Ready transition the daemon renders the working spec to a file and commits it to the task branch. The builder's worktree is a checkout of that branch, so it sees the spec via git with no copying. Specs persist in main as institutional memory after merge.
- Kanban state, run history, gate results — SQLite. Pure state machine data and append-only logs.

The split maps to the board: authoring is collaborative and mutable (SQLite); the build run is contractual and immutable (committed file). The freeze at Ready is the only bridge between them.

## 4. Anti-corruption layer around ACPX

ACPX is alpha and its CLI/runtime interfaces are expected to change. Do not couple the core to it.

- Define an internal Agent interface: spawn(cwd, agentId), prompt(session, text), streamEvents(session), cancel(session), close(session).
- ACPX sits behind one adapter implementing that interface.
- If ACPX churns, fix the adapter. If ACPX dies, implement the same interface directly against ACP JSON-RPC (ACPX becomes reference, not dependency).
- Pin the ACPX version. Review the npm postinstall hook (it fetches platform binaries) before trusting it on your box.

The risk is deliberately contained to one replaceable component sitting on top of a stable protocol. That, not any vendor's backing, is the safety story.

## 5. The loop

### 5.1 Board states

copy


Backlog / Spec  ->  Ready  ->  Building  ->  Validating  ->  Review  ->  Done

- Backlog / Spec — human drafts the task in a grill-me chat UI with an agent (see 7). Human owns the final acceptance criteria. Working spec lives in SQLite during this phase.
- Ready — human marks the spec frozen. Daemon renders it to a committed markdown file (see 3.4). Signals the orchestrator to pick it up.
- Building — orchestrator spins a worktree, runs the builder agent (opencode) headless until the fast in-loop gates pass or a step budget is hit. The agent self-plans via its own todo tooling; there is no separate Plan board state — planning is internal to the build run, not a HITL checkpoint.
- Validating — the boundary gate runs in a separate worktree with a different model (pi). Tests live in the repo; the builder can see them, but they are executed by the decorrelated validator.
- Review — human reviews the diff, comments, merges.
- Done — merged.

### 5.2 Failure routing (state machine)

- In-loop gate fails -> builder iterates in place until pass or step budget.
- Boundary gate fails -> bounce back to Building with the failure output as fresh context. Cap at N retries (start N = 2 or 3).
- Retry cap exceeded -> escalate to human (move to Review with a failure summary).
- Boundary gate passes + change-class is on the trusted auto-merge list -> auto-merge (later phases only).
- Boundary gate passes + change-class not trusted -> Review.

Concurrency capped at 1 initially.

## 6. Verification and validation

Two levels, borrowed from the mainstream software-factory framing:

- In-loop (fast, cheap, deterministic): typecheck, lint, unit tests. Runs inside the builder's iteration. The builder can see and fix these.
- Boundary (comprehensive): integration and scenario tests, run in a separate disposable worktree after the build. The tests live in the repo — the builder can see them — but they are executed by the decorrelated validator, not the builder.

Decorrelated validator: the boundary gate uses a different model/agent than the build. This is the single highest-leverage design choice for "no mistakes" — a second model in a clean worktree, re-checking the builder's diff against the full test suite, catches what the builder's blind spots miss.

## 7. Spec authoring

- The spec-authoring surface is a grill-me chat UI: the human and an agent iterate on the spec conversationally, bouncing ideas and exploring before finalizing. The working spec lives in SQLite during this phase (concurrent editing, WebSocket broadcast).
- Human owns acceptance criteria. An agent may help draft the spec, but if the same agent writes and implements it, it will write a spec it already knows it can satisfy.
- At the Ready transition, the daemon freezes the working spec: renders it to `specs/NNNN-slug.md` and commits it to the task branch. This frozen file is the immutable contract for the build run. The builder reads it via git in its worktree. If the spec is wrong mid-build, that is a new build run — unfreeze, revise, re-freeze.
- Acceptance criteria in the spec map to the boundary gate's test suite (visible to the builder, executed by the decorrelated validator).

## 8. Security and sandboxing

- ACP/ACPX and OpenClaw do NOT sandbox the harness. The agent runs on the host with its own CLI file/exec permissions, and headless runs need a permissive profile (e.g. approve-all) because there is no TTY to approve prompts.
- Therefore isolation is our responsibility: run the builder inside a container or throwaway VM, scoped to the task worktree. Do not run approve-all agents bare on the host.
- Pin alpha dependencies; audit postinstall hooks; keep provider credentials out of the agent's blast radius where possible.

## 9. Dependencies and risk posture

| Component | Role | Risk | Mitigation |
|---|---|---|---|
| ACP | agent protocol | low (durable, multi-vendor) | target directly as fallback |
| ACPX | ACP client | high (alpha, changing) | anti-corruption adapter, pin version |
| opencode | builder agent | low | swappable via ACP |
| pi | validator agent | low-med (smaller
ecosystem) | swappable via ACP |
| git worktrees | isolation | low | standard |
| SQLite | state | low | standard |

## 10. Build sequencing

- M0 — vertical slice / go-no-go. Daemon spawns opencode via the ACPX adapter on a Ready task, runs headless in a worktree to completion, hands the diff to pi as validator, and routes pass/fail through the state machine. No UI yet. This proves or kills the whole design.
- M1 — control plane. Kanban board (web), task state in SQLite, worktree lifecycle, PR creation and merge.
- M2 — the gate, first-class. Two-level verification, decorrelated validator, retry/escalation routing. This is the differentiator; invest here.
- M3 — more agents. claude, codex, gemini, kimi via ACP. Mostly config, not code.
- M4 — clients. TUI, optional VS Code webview panel. Editor deep-links.

## 11. Open questions

- Container vs VM for builder isolation on the VPS? (devcontainer is probably enough; VM if paranoid.)
- Auto-merge change-class taxonomy: which classes graduate first (docs, tests, pure refactors)?
- Do we adopt OpenClaw's gateway wholesale, or use ACPX standalone and build our own orchestration? (Leaning standalone ACPX to avoid coupling to a second large moving system.)
- Naming.

## 12. Prior art and references

- vibe kanban (BloopAI) — the board/worktree/PR model; now community-maintained after Bloop's shutdown.
- no-mistakes (kunchenguid) — local git proxy that runs an AI validation pipeline in a disposable worktree and forwards a clean PR only after checks pass. The gate model to steal.
- ACPX / OpenClaw (openclaw org) — headless ACP client and agent gateway. Independent open source, not OpenAI-backed.
- ACP (Zed) — the agent-editor protocol standard; the durable substrate.
- opencode, pi — the first two executors.