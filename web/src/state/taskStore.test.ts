import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTaskStore } from "./taskStore";
import { useToastStore } from "./toastStore";
import type { TaskCard } from "../types";

function card(overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    id: 1,
    slug: "task",
    title: "Task",
    status: "ready",
    retry_count: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("taskStore", () => {
  beforeEach(() => {
    useTaskStore.setState({ tasksById: {}, specMessagesBySlug: {}, socketStatus: "connecting" });
    useToastStore.setState({ toasts: [] });
  });

  it("replaces task projections on a connected snapshot", () => {
    const apply = useTaskStore.getState().applyTaskEvent;
    apply({ type: "task.created", payload: card({ id: 9 }), timestamp: "now" });
    apply({ type: "connected", payload: { tasks: [card({ id: 2 })] }, timestamp: "now" });
    expect(Object.keys(useTaskStore.getState().tasksById)).toEqual(["2"]);
  });

  it("deduplicates duplicate spec messages", () => {
    const apply = useTaskStore.getState().applyTaskEvent;
    const message = { id: 1, task_id: 1, role: "assistant" as const, content: "hi", created_at: "now" };
    apply({ type: "spec.message", payload: { taskSlug: "task", message }, timestamp: "now" });
    apply({ type: "spec.message", payload: { taskSlug: "task", message }, timestamp: "now" });
    expect(useTaskStore.getState().specMessagesBySlug[":task"]).toHaveLength(1);
  });

  it("rolls back an optimistic transition when the API fails", async () => {
    const previous = card();
    useTaskStore.getState().applyTaskEvent({ type: "connected", payload: { tasks: [previous] }, timestamp: "now" });
    const api = await import("../api/client");
    vi.spyOn(api, "transitionTask").mockRejectedValueOnce(new Error("offline"));

    await useTaskStore.getState().transitionTask("task", "building", previous);

    expect(useTaskStore.getState().tasksById[1]).toEqual(previous);
    expect(useToastStore.getState().toasts[0]?.kind).toBe("error");
  });
});
