# Marshal

A local-first, agent-agnostic coding-agent orchestrator — a "software factory" loop where a human authors the spec, a coding agent (the "builder") autonomously implements it in an isolated worktree, a different agent (the "validator") runs the verification gate, and the human reviews and merges.

The state machine, HTTP/WS API, agent layer, retry routing, and security model are documented in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). This document is the higher-level vision and design tenets — the _why_ behind the shape, not the _what_ or the _where_.

---

## 1. Vision

A self-hosted control plane for driving coding agents through a build-verify-review loop with human-in-the-loop only at the two points where judgment matters: authoring the spec (front) and reviewing the merge (back). Everything in between runs unattended.

The reason to exist is the part vibe kanban never had a strong opinion about: a first-class verification and validation gate. The board, worktrees, and PR flow are table stakes; the opinionated gate is the differentiator.

Deployment target is a single box or a VPS. Models are accessed via API; "local" refers to the orchestration and verification running on infrastructure you control.

## 2. Design tenets

1. **Verification is the product.** With the human out of the per-diff loop, the only thing preventing silent corruption is the gate. Build the gate before the autonomy.
2. **Agent-agnostic.** The supported-agent count must be a function of protocol coverage, not our labor. Marshal ships no preferred agent; the user picks at init time.
3. **Minimize HITL to the two ends.** Human owns the spec and the merge. The middle is unattended.
4. **Decorrelated builder and validator.** Build with one model, validate with a different one, so the validator does not share the builder's blind spots.
5. **Incremental trust.** Start HITL-heavy, remove human gates only as automated gates prove reliable. Auto-merge is earned per change-class, not granted up front.
6. **Concurrency 1 to start.** Worktrees solve file-level conflicts, not semantic ones. One task at a time sidesteps the one genuinely unsolved problem until the gate is strong enough to trust more.
7. **Thin clients, fat daemon.** The backend owns all real state and work; clients are faces over one API.

## 3. Architecture, at a glance

A daemon owns the orchestrator, the worktree manager, the agent layer, the validation gate, the state, and the HTTP + WebSocket API. State is per-repo and discovered via the cwd-walked repo root. Clients (the web board, the CLI, future TUI) are thin adapters over the same API.

The agent layer targets the [Agent Client Protocol](https://agentclientprotocol.com) directly through the official TypeScript SDK. Marshal owns process lifecycle, permission policy, timeout, cancellation, and event mapping behind its stable `Agent` interface. Structured executable commands are required for every role. The safety and portability contract is ACP.

A task's lifecycle is `backlog → ready → building → validating → review → done`, with human-driven escape hatches out of `building`, `validating`, and `review` back to earlier states. The spec is mutable in SQLite while the task is in `backlog`; the freeze at the Ready transition commits it to the task branch as the immutable build contract.

## 4. The verification gate

Two levels, borrowed from the mainstream software-factory framing:

- **In-loop** (fast, cheap, deterministic): typecheck, lint, unit tests. Runs inside the builder's iteration. The builder sees and fixes these.
- **Boundary** (comprehensive): integration and scenario tests, run in a different agent in a separate worktree (or the builder's, after a clean commit) after the build.

The decorrelated validator — a different model, re-executing the full boundary test suite against the builder's diff — is the single highest-leverage design choice for "no mistakes."

The gate signal is the exit code and structured report from deterministic test execution, not free-form model judgment on whether the diff satisfies the spec. Tenet #1 holds only when the gate is deterministic and auditable. Advisory, narrative model judgments may exist alongside, but they are explicitly labeled advisory — never conflated with the gate result.

## 5. The spec and human ownership

The human owns the spec from start to finish. An agent can help draft, ask clarifying questions, and surface gaps before the task is frozen — but the human approves acceptance criteria. A spec must be scoped to a single mergeable diff completable within the configured step and spend budgets, not a multi-day epic. Larger work is decomposed before authoring.

The spec-authoring surface is a grill-me chat where the human and an agent iterate on the spec conversationally. The working spec is mutable in SQLite during this phase; the freeze at the Ready transition commits it to the task branch. The frozen spec and the boundary test files freeze together as one atomic build contract. If the spec is wrong mid-build, that is a new build run — unfreeze, revise, re-freeze.

## 6. Failure routing

Validator failures bounce back to a fresh build attempt, with the previous failure as context, up to a configured cap. Cap exceeded escalates to human review with a failure summary. Builder failures leave the task stuck for human inspection — manual recovery via the escape hatches. Recovery is explicit and conservative, not automatic; the orchestrator never silently retries after a crash.

A per-task spend ceiling is a non-functional requirement alongside the step budget. Steps vary arbitrarily in token cost; the retry loop compounds spend further. The ceiling caps total cost regardless of step count or size. Reaching the ceiling is treated identically to exceeding the retry cap — escalate to human review.

## 7. Security and isolation

The daemon's HTTP + WebSocket API can spawn processes with file/exec permissions on request. It is therefore an RCE-as-a-service surface when reachable beyond localhost. The daemon binds to `127.0.0.1` only by default. Any exposure beyond localhost requires an authenticated tunnel or token-based auth. An unauthenticated listener reachable beyond localhost is never acceptable.

ACP does **not** sandbox the agent. The agent runs on the host with its own CLI file/exec permissions, and headless runs need a permissive profile because there is no TTY to approve prompts. Isolation — running the builder inside a container or throwaway VM scoped to the task worktree — is therefore the operator's responsibility. Running approve-all agents bare on the host is unsafe in any scenario where the agent can reach paths beyond the task worktree.

## 8. Build sequencing

- **M0** — vertical slice / go-no-go. Daemon spawns the configured builder through the `Agent` interface on a Ready task, runs headless in a worktree to completion, hands the diff to the configured validator, and routes pass/fail through the state machine. No UI. Proves or kills the whole design.
- **M1** — control plane. HTTP + WebSocket API, Kanban board, task lifecycle visible and driveable from the browser, local merge flow.
- **M2** — the gate, first-class. Two-level verification, decorrelated validator with the discipline of §4, retry/escalation routing made load-bearing. The differentiator; invest here.
- **M3** — more agents. Mostly config, not code.
- **M4** — additional clients. TUI, optional VS Code webview. Editor deep-links.

## 9. Open questions

- Container vs VM for builder isolation on the VPS? (devcontainer is probably enough; VM if paranoid.)
- Auto-merge change-class taxonomy: which classes graduate first (docs, tests, pure refactors)?
- Naming. (Working title is "Marshal".)

## 10. Prior art and references

- **vibe kanban** (BloopAI) — the board/worktree/PR model; community-maintained after Bloop's shutdown. The shape Marshal's M1 inherits.
- **no-mistakes** (kunchenguid) — local git proxy that runs an AI validation pipeline in a disposable worktree and forwards a clean PR only after checks pass. The gate model to steal.
- **ACP** (Zed) — the agent-editor protocol standard; the durable substrate.
- **opencode**, **pi** — early executors used to prove the loop; any ACP-compatible executable is now a config choice.
