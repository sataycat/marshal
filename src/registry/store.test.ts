import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { beginRegistryRefresh, completeRegistryRefresh, failRegistryRefresh, getRegistryCatalog } from "./store.js";

describe("registry store", () => {
  it("retains the last valid snapshot when a later refresh fails", () => {
    const machine = mkdtempSync(join(tmpdir(), "marshal-registry-"));
    const first = beginRegistryRefresh(machine);
    const snapshot = { version: "1.0.0", agents: [], source: "fixture://registry", fetched_at: new Date().toISOString() };
    completeRegistryRefresh(first.id, snapshot, machine);
    const failed = beginRegistryRefresh(machine);
    failRegistryRefresh(failed.id, "network unavailable", machine);
    const catalog = getRegistryCatalog(machine);
    expect(catalog.snapshot).toEqual(snapshot);
    expect(catalog.refresh).toEqual(expect.objectContaining({ status: "failed", error: "network unavailable" }));
  });
});
