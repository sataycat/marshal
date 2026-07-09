import { describe, expect, it, vi } from "vitest";
import {
  DaemonCycleCompleteType,
  DaemonIdleType,
  EventBus,
  TaskCreatedType,
  TaskTransitionedType,
  publishDaemonCycleComplete,
  publishDaemonIdle,
  publishTaskCreated,
  publishTaskTransitioned,
} from "./bus.js";

describe("EventBus", () => {
  it("delivers published events to every active subscriber", () => {
    const bus = new EventBus();
    const eventsA: string[] = [];
    const eventsB: string[] = [];
    bus.subscribe((e) => eventsA.push(e.type));
    bus.subscribe((e) => eventsB.push(e.type));

    publishTaskCreated(bus, {
      id: 1,
      slug: "x",
      title: "X",
      status: "backlog",
      retry_count: 0,
      created_at: "2026-07-09T00:00:00.000Z",
      updated_at: "2026-07-09T00:00:00.000Z",
    });
    publishDaemonIdle(bus);

    expect(eventsA).toEqual([TaskCreatedType, DaemonIdleType]);
    expect(eventsB).toEqual([TaskCreatedType, DaemonIdleType]);
  });

  it("returns an unsubscribe function that stops further delivery", () => {
    const bus = new EventBus();
    const events: string[] = [];
    const unsubscribe = bus.subscribe((e) => events.push(e.type));

    publishTaskCreated(bus, {
      id: 1,
      slug: "x",
      title: "X",
      status: "backlog",
      retry_count: 0,
      created_at: "2026-07-09T00:00:00.000Z",
      updated_at: "2026-07-09T00:00:00.000Z",
    });
    unsubscribe();
    publishDaemonCycleComplete(bus);

    expect(events).toEqual([TaskCreatedType]);
  });

  it("isolates failures: a throwing subscriber does not block others", () => {
    const bus = new EventBus();
    const ok: string[] = [];
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe((e) => ok.push(e.type));

    publishDaemonIdle(bus);

    expect(ok).toEqual([DaemonIdleType]);
  });

  it("stamps every event with an ISO-8601 timestamp and dot-separated type", () => {
    const bus = new EventBus();
    let seen: { type: string; timestamp: string } | undefined;
    bus.subscribe((e) => {
      seen = { type: e.type, timestamp: e.timestamp };
    });

    publishTaskTransitioned(
      bus,
      {
        id: 1,
        slug: "x",
        title: "X",
        status: "ready",
        retry_count: 0,
        created_at: "2026-07-09T00:00:00.000Z",
        updated_at: "2026-07-09T00:00:00.000Z",
      },
      "backlog",
      "ready",
    );

    expect(seen?.type).toBe(TaskTransitionedType);
    expect(seen?.timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/,
    );
  });

  it("does not deliver to subscribers added during a publish loop for the in-flight event", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe((e) => {
      seen.push(e.type);
      if (e.type === TaskCreatedType) {
        bus.subscribe((e2) => seen.push(e2.type));
      }
    });

    publishDaemonCycleComplete(bus);

    expect(seen).toEqual([DaemonCycleCompleteType]);
  });

  it("accepts a vi spy subscriber and receives synthetic events", () => {
    const bus = new EventBus();
    const spy = vi.fn();
    bus.subscribe(spy);

    bus.publish("custom.event", { any: "thing" });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({ type: "custom.event", payload: { any: "thing" } });
  });
});