import { describe, it, expect } from "vitest";
import { boardReducer, boardToList, type BoardState } from "./reducer";
import type { BusEvent, TaskCard } from "../types";

function card(over: Partial<TaskCard> = {}): TaskCard {
  return {
    id: 1,
    slug: "x",
    title: "X",
    status: "backlog",
    retry_count: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function ev(type: string, payload: unknown): BusEvent {
  return { type, payload, timestamp: "2026-01-01T00:00:00.000Z" };
}

describe("boardReducer", () => {
  it("connected replaces state with the snapshot", () => {
    const state: BoardState = { 9: card({ id: 9 }) };
    const next = boardReducer(
      state,
      ev("connected", { tasks: [card({ id: 1, slug: "a" }), card({ id: 2, slug: "b" })] }),
    );
    expect(Object.keys(next).sort()).toEqual(["1", "2"]);
    expect(next[9]).toBeUndefined();
  });

  it("task.created adds a task", () => {
    const next = boardReducer({}, ev("task.created", card({ id: 5, slug: "new" })));
    expect(next[5]?.slug).toBe("new");
  });

  it("task.transitioned updates an existing task in place", () => {
    const state: BoardState = { 1: card({ id: 1, status: "ready" }) };
    const next = boardReducer(
      state,
      ev("task.transitioned", {
        ...card({ id: 1, status: "building" }),
        from: "ready",
        to: "building",
      }),
    );
    expect(next[1]?.status).toBe("building");
  });

  it("task.updated upserts an unknown task defensively", () => {
    const next = boardReducer({}, ev("task.updated", card({ id: 7, status: "review" })));
    expect(next[7]?.status).toBe("review");
  });

  it("unknown event types leave state unchanged (same reference)", () => {
    const state: BoardState = { 1: card({ id: 1 }) };
    const next = boardReducer(state, ev("run.started", { id: 99 }));
    expect(next).toBe(state);
  });
});

describe("boardToList", () => {
  it("orders newest first by created_at, breaking ties by id desc", () => {
    const state: BoardState = {
      1: card({ id: 1, created_at: "2026-01-01T00:00:00.000Z" }),
      2: card({ id: 2, created_at: "2026-01-02T00:00:00.000Z" }),
      3: card({ id: 3, created_at: "2026-01-01T00:00:00.000Z" }),
    };
    expect(boardToList(state).map((t) => t.id)).toEqual([2, 3, 1]);
  });

  it("returns an empty array for empty state", () => {
    expect(boardToList({})).toEqual([]);
  });
});
