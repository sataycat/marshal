# Glossary

## ACP

Agent Client Protocol. Zed's JSON-RPC over stdio standard for agent-editor communication. The durable, multi-vendor substrate for agent integration.

## ACPX

OpenClaw's headless ACP client. Provides persistent named sessions, prompt queueing, cancellation, cwd sandboxing, permission modes, and structured typed output. Alpha; wrapped behind Marshal's internal adapter interface.

## Boundary gate

The comprehensive verification step run in a separate disposable worktree by a decorrelated validator after the build. Executes integration and scenario tests.

## Builder

The agent responsible for implementing the spec. Runs in its own disposable git worktree. In M0 this is opencode.

## Daemon

The headless Node backend that owns orchestration, worktree management, agent adapters, validation, state, and the HTTP + WebSocket API.

## Decorrelated validator

A validator that uses a different model/agent than the builder, so it does not share the builder's blind spots.

## Frozen spec

The committed markdown spec (`specs/NNNN-slug.md`) that becomes the immutable build contract when a task moves to Ready.

## Grill-me chat

The spec-authoring UI where a human and an agent iterate conversationally on the working spec before it is frozen.

## In-loop gate

Fast, cheap, deterministic checks (typecheck, lint, unit tests) run inside the builder's iteration.

## Marshal

Working title for the local-first, agent-agnostic coding-agent orchestrator described in this repo.

## Ready

The board state where the working spec is frozen, committed, and picked up by the orchestrator for building.

## Task branch

A disposable git branch + worktree created for each task and cleaned up after completion.

## Validator

The agent responsible for running the boundary gate. In M0 this is pi.

## Working spec

The mutable spec being authored in the grill-me chat UI, stored in SQLite until it is frozen at Ready.
