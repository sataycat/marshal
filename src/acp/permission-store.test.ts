import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerRepository } from "../repositories/store.js";
import { createSession } from "./supervisor-store.js";
import { createPermissionRequest, getPermissionRequestForThread, listPermissionRequests, reconcilePermissionRequests, resolvePermissionRequest } from "./permission-store.js";

describe("durable permission requests", () => {
  it("persists raw ACP choices and reconciles unresolved requests", () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-permissions-"));
    const machine = mkdtempSync(join(tmpdir(), "marshal-permissions-machine-"));
    const repository = registerRepository(root, machine);
    const session = createSession(repository.id, { ownerType: "thread", ownerId: "thread-1", agentId: "fake", agentVersion: "1" }, machine);
    const request = createPermissionRequest(repository.id, session.id, "thread-1", { requestId: "req", sessionId: "acp", tool: "write", kind: "file", rawInput: { path: "x" }, options: [{ optionId: "deny-id", name: "No", kind: "reject_once" }, { optionId: "allow-id", name: "Yes", kind: "allow_once" }] }, machine);
    expect(getPermissionRequestForThread(repository.id, "thread-1", "req", machine)?.options[1].optionId).toBe("allow-id");
    expect(resolvePermissionRequest(repository.id, request.id, "approved", "allow-id", "approve", null, machine).status).toBe("approved");
    expect(resolvePermissionRequest(repository.id, request.id, "denied", "deny-id", "deny", null, machine).status).toBe("approved");
    const second = createPermissionRequest(repository.id, session.id, "thread-1", { requestId: "req-2", sessionId: "acp", tool: "run", options: [] }, machine);
    reconcilePermissionRequests(repository.id, session.id, "interrupted", "daemon restart", machine);
    expect(listPermissionRequests(repository.id, "thread-1", machine).find((item) => item.id === second.id)?.status).toBe("interrupted");
  });
});
