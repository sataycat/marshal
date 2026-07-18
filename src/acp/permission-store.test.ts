import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initRepoState } from "../daemon/config.js";
import { createSession } from "./supervisor-store.js";
import { createPermissionRequest, getPermissionRequestForThread, listPermissionRequests, reconcilePermissionRequests, resolvePermissionRequest } from "./permission-store.js";

describe("durable permission requests", () => {
  it("persists raw ACP choices and reconciles unresolved requests", () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-permissions-"));
    initRepoState(root);
    const session = createSession({ ownerType: "thread", ownerId: "thread-1", agentId: "fake", agentVersion: "1" }, root);
    const request = createPermissionRequest(session.id, "thread-1", { requestId: "req", sessionId: "acp", tool: "write", kind: "file", rawInput: { path: "x" }, options: [{ optionId: "deny-id", name: "No", kind: "reject_once" }, { optionId: "allow-id", name: "Yes", kind: "allow_once" }] }, root);
    expect(getPermissionRequestForThread("thread-1", "req", root)?.options[1].optionId).toBe("allow-id");
    expect(resolvePermissionRequest(request.id, "approved", "allow-id", "approve", null, root).status).toBe("approved");
    expect(resolvePermissionRequest(request.id, "denied", "deny-id", "deny", null, root).status).toBe("approved");
    const second = createPermissionRequest(session.id, "thread-1", { requestId: "req-2", sessionId: "acp", tool: "run", options: [] }, root);
    reconcilePermissionRequests(session.id, "interrupted", "daemon restart", root);
    expect(listPermissionRequests("thread-1", root).find((item) => item.id === second.id)?.status).toBe("interrupted");
  });
});
