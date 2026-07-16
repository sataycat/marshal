import { describe, expect, it } from "vitest";
import { EventBus } from "./bus.js";
import { PermissionBroker } from "./permission-broker.js";

const request = {
  requestId: "request-1",
  sessionId: "session-1",
  tool: "Execute command",
  kind: "execute",
  options: [
    { optionId: "reject-first", name: "Reject", kind: "reject_once" as const },
    { optionId: "allow-later", name: "Allow", kind: "allow_once" as const },
  ],
};

describe("permission broker", () => {
  it("publishes a request and selects only the matching ACP option kind", async () => {
    const bus = new EventBus();
    const events: string[] = [];
    bus.subscribe((event) => events.push(event.type));
    const broker = new PermissionBroker(bus);
    const result = broker.request("thread-1", request);
    expect(broker.list("thread-1")[0]).toMatchObject({ requestId: "request-1", threadId: "thread-1" });
    broker.decide("thread-1", "request-1", "approve");
    await expect(result).resolves.toBe("allow-later");
    expect(events).toEqual(["thread.event", "thread.event"]);
    expect(broker.list("thread-1")).toEqual([]);
  });

  it("rejects stale, cross-thread, and unavailable decisions without resolving", async () => {
    const broker = new PermissionBroker();
    const result = broker.request("thread-1", { ...request, requestId: "request-2", options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] });
    expect(() => broker.decide("thread-2", "request-2", "approve")).toThrow("stale or unknown");
    expect(() => broker.decide("thread-1", "request-2", "deny")).toThrow("does not offer reject_once");
    broker.cancelThread("thread-1");
    await expect(result).resolves.toBeUndefined();
    expect(() => broker.decide("thread-1", "request-2", "approve")).toThrow("stale or unknown");
  });
});
