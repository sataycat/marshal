import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { queryKeys } from "../api/queryKeys";
import { reconcileBusEvent } from "./queryReconciliation";

describe("query reconciliation", () => {
  it("merges duplicate thread messages by durable id", () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.thread("t"), { thread: {}, messages: [{ id: 1, content: "old" }] });
    const event = { type: "thread.message", payload: { threadId: "t", message: { id: 1, content: "new" } }, timestamp: "now" };
    reconcileBusEvent(client, event);
    reconcileBusEvent(client, event);
    expect(client.getQueryData<{ messages: Array<{ id: number; content: string }> }>(queryKeys.thread("t"))?.messages).toEqual([{ id: 1, content: "new" }]);
  });
});
