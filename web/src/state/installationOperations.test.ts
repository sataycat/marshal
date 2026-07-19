import { describe, expect, it } from "vitest";
import { applyInstallationOperationEvent, cancelInstallationOperation, isTerminalInstallationOperation, retryInstallationOperation, type InstallationOperationsState } from "./installationOperations";
import type { InstallationOperation } from "../types";

function operation(overrides: Partial<InstallationOperation> = {}): InstallationOperation {
  return {
    id: "op-1", agent_id: "agent", version: "1.0.0", package_specifier: "agent@1.0.0", distribution: "npx", installation_id: "agent@1.0.0:npx", phase: "resolving", status: "installing", started_at: "now", finished_at: null, error: null, error_code: null, diagnostic: null, ...overrides,
  };
}

describe("installation operation state", () => {
  it("applies progress events and ignores unrelated events", () => {
    const initial: InstallationOperationsState = { byId: {} };
    const progress = operation({ phase: "downloading" });
    const next = applyInstallationOperationEvent(initial, { type: "installation.operation.updated", payload: { operation: progress }, timestamp: "now" });
    expect(next.byId["op-1"].phase).toBe("downloading");
    expect(applyInstallationOperationEvent(next, { type: "task.updated", payload: {}, timestamp: "now" })).toBe(next);
  });

  it("recognizes all terminal states and preserves actionable failure data", () => {
    expect(isTerminalInstallationOperation(operation({ phase: "completed", status: "installed" }))).toBe(true);
    expect(isTerminalInstallationOperation(operation({ phase: "failed", status: "failed", error_code: "download_timeout", diagnostic: { message: "timed out", action: "Retry" } }))).toBe(true);
    expect(isTerminalInstallationOperation(operation({ phase: "interrupted", status: "interrupted" }))).toBe(true);
  });

  it("resets a failed operation for retry without losing its identity", () => {
    const failed = operation({ phase: "failed", status: "failed", finished_at: "later", error: "nope", error_code: "installation_failed", diagnostic: { message: "nope", action: "Retry" } });
    const retried = retryInstallationOperation({ byId: {} }, failed).byId[failed.id];
    expect(retried).toMatchObject({ id: failed.id, status: "installing", phase: "resolving", finished_at: null, error: null, error_code: null, diagnostic: null });
  });

  it("marks a live operation interrupted and ignores cancellation after terminal state", () => {
    const live = operation({ phase: "downloading" });
    expect(cancelInstallationOperation({ byId: {} }, live).byId[live.id]).toMatchObject({ status: "interrupted", phase: "interrupted", error_code: "installation_cancelled" });
    const done = operation({ phase: "completed", status: "installed" });
    expect(cancelInstallationOperation({ byId: { [done.id]: done } }, done).byId[done.id]).toEqual(done);
  });
});
