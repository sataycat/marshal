import { describe, it, expect } from "vitest";
import { specMessagesReducer, messagesForSlug } from "./specMessagesReducer";
import type { BusEvent, SpecMessage } from "../types";

function msg(id: number, role: "user" | "assistant", content: string): SpecMessage {
  return { id, task_id: 1, role, content, created_at: "2026-01-01T00:00:00.000Z" };
}

function ev(type: string, payload: unknown): BusEvent {
  return { type, payload, timestamp: "2026-01-01T00:00:00.000Z" };
}

describe("specMessagesReducer", () => {
  it("appends a spec.message for the matching slug", () => {
    const next = specMessagesReducer(
      {},
      ev("spec.message", { taskSlug: "a", message: msg(1, "user", "hi") }),
    );
    expect(messagesForSlug(next, ":a")).toEqual([msg(1, "user", "hi")]);
    expect(messagesForSlug(next, ":other")).toEqual([]);
  });

  it("does not duplicate a message that already exists", () => {
    const state = { ":a": [msg(1, "user", "hi")] };
    const next = specMessagesReducer(
      state,
      ev("spec.message", { taskSlug: "a", message: msg(1, "user", "hi") }),
    );
    expect(messagesForSlug(next, ":a")).toHaveLength(1);
  });

  it("preserves messages for other slugs when one slug updates", () => {
    const state = { ":a": [msg(1, "user", "hi")] };
    const next = specMessagesReducer(
      state,
      ev("spec.message", { taskSlug: "b", message: msg(2, "assistant", "yo") }),
    );
    expect(messagesForSlug(next, ":a")).toHaveLength(1);
    expect(messagesForSlug(next, ":b")).toHaveLength(1);
  });

  it("appends subsequent messages in arrival order", () => {
    let state = specMessagesReducer(
      {},
      ev("spec.message", { taskSlug: "a", message: msg(1, "user", "hi") }),
    );
    state = specMessagesReducer(
      state,
      ev("spec.message", { taskSlug: "a", message: msg(5, "assistant", "yo") }),
    );
    expect(messagesForSlug(state, ":a").map((m) => m.id)).toEqual([1, 5]);
  });

  it("resets to empty on connected (HTTP is the durable source)", () => {
    const state = { a: [msg(1, "user", "hi")] };
    const next = specMessagesReducer(state, ev("connected", { tasks: [] }));
    expect(next).toEqual({});
  });

  it("leaves state unchanged for unrelated event types", () => {
    const state = { a: [msg(1, "user", "hi")] };
    const next = specMessagesReducer(state, ev("task.created", { id: 9 }));
    expect(next).toBe(state);
  });

  it("messagesForSlug returns [] for an unknown slug", () => {
    expect(messagesForSlug({}, "unknown")).toEqual([]);
  });
});
