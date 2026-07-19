import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { exactNpxPackage, exactUvxPackage, installCandidate, selectDistribution, startInstallation } from "./installer.js";
import { createInstallation, getInstalledAgent, getInstallationOperation, reconcileInstallationOperations } from "../agents/store.js";
import type { RegistryAgent } from "../registry/types.js";

const uvxAgent: RegistryAgent = {
  id: "uv-agent", name: "UV Agent", version: "1.2.3", description: "fixture", license: "MIT", authors: [],
  distributions: [{ kind: "uvx", package: "uv-agent==1.2.3", args: ["acp"] }],
};

describe("uvx installations", () => {
  it("uses lifecycle distribution precedence and honors an explicit override", () => {
    const agent: RegistryAgent = {
      id: "precedence", name: "Precedence", version: "1.2.3", description: "fixture", license: "MIT", authors: [],
      distributions: [
        { kind: "binary", platforms: ["linux-x64"], archive_url: "https://example.invalid/unverified.tgz", archive_format: "tgz", executable: "agent" },
        { kind: "binary", platforms: ["linux-x64"], archive_url: "https://example.invalid/verified.tgz", archive_format: "tgz", checksum: "a".repeat(64), executable: "agent" },
        { kind: "npx", package: "precedence@1.2.3" },
        { kind: "uvx", package: "precedence==1.2.3" },
      ],
    };
    expect(selectDistribution(agent, "linux-x64").archive_url).toContain("verified");
    expect(selectDistribution(agent, "linux-arm64").kind).toBe("npx");
    expect(selectDistribution(agent, "linux-x64", "npx").kind).toBe("npx");
    expect(selectDistribution(agent, "linux-x64", "uvx").kind).toBe("uvx");
    expect(installCandidate(agent, "linux-x64", "binary")).toMatchObject({ checksum: "a".repeat(64), integrity_policy: "verified_if_declared" });
  });

  it("accepts only exact package launch pins for both package distributions", () => {
    expect(exactNpxPackage("precedence@1.2.3")).toBe("precedence@1.2.3");
    expect(exactUvxPackage("precedence==1.2.3")).toBe("precedence==1.2.3");
  });

  it("rejects moving aliases and preserves exact package pins", () => {
    expect(exactUvxPackage("uv-agent==1.2.3")).toBe("uv-agent==1.2.3");
    for (const value of ["uv-agent", "uv-agent==latest", "uv-agent==main", "uv-agent==1.2", "uv-agent==1.2.3 foo"]) {
      expect(() => exactUvxPackage(value)).toThrow(/exact package/);
    }
  });

  it("selects uvx fallback and persists a no-install launch specification", async () => {
    const machineDir = mkdtempSync(`${tmpdir()}/marshal-uvx-`);
    const seen: string[] = [];
    const operation = await startInstallation(uvxAgent, machineDir, async (specifier, cwd) => { seen.push(`${specifier}:${cwd}`); });
    expect(selectDistribution(uvxAgent).kind).toBe("uvx");
    expect(seen).toHaveLength(1);
    const installed = getInstalledAgent("uv-agent", "1.2.3", machineDir);
    expect(installed?.package_specifier).toBe("uv-agent==1.2.3");
    expect(installed?.launch).toEqual({ command: "uvx", args: ["--from", "uv-agent==1.2.3", "uv-agent", "acp"] });
    expect(installed?.provenance).toMatchObject({ distribution: "uvx", package_specifier: "uv-agent==1.2.3" });
    expect(operation.status).toBe("installing");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(getInstalledAgent("uv-agent", "1.2.3", machineDir)?.status).toBe("installed");
  });

  it("publishes through a unique root and reuses duplicate identity", async () => {
    const machineDir = mkdtempSync(`${tmpdir()}/marshal-atomic-`);
    const first = await startInstallation(uvxAgent, machineDir, async (_specifier, cwd) => { const marker = `${cwd}/payload`; await import("node:fs").then(({ writeFileSync }) => writeFileSync(marker, "ok")); });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await startInstallation(uvxAgent, machineDir, async () => { throw new Error("duplicate must not run"); });
    expect(second.id).toBe(first.id);
    const operation = getInstallationOperation(first.id, machineDir)!;
    expect(operation.phase).toBe("completed");
    expect(operation.published_root).toContain("/agents/uv-agent/1.2.3/");
    expect(operation.published_root).not.toBe(operation.temporary_root);
    expect(existsSync(`${operation.published_root}/manifest.json`)).toBe(true);
    expect(JSON.parse(readFileSync(`${operation.published_root}/manifest.json`, "utf8")).installation_id).toContain("uv-agent@1.2.3:uvx:");
  });

  it("marks incomplete operations interrupted and cleans temporary roots on recovery", () => {
    const machineDir = mkdtempSync(`${tmpdir()}/marshal-recovery-`);
    const created = createInstallation({ id: "uv-agent", version: "1.2.3", source: "registry", license: "MIT", distribution: "uvx", package_specifier: "uv-agent==1.2.3", launch: { command: "uvx", args: ["--from", "uv-agent==1.2.3", "uv-agent"] }, registry_snapshot_fetched_at: null, integrity_status: "not_applicable", status: "installing", readiness_status: "unknown", readiness_error: null, protocol_version: null, capabilities: null, auth_methods: [], raw_initialize: null, probed_at: null }, "recovery-op", machineDir, { temporary_root: `${machineDir}/agents/.tmp-stale`, published_root: `${machineDir}/agents/uv-agent/1.2.3/stale` });
    reconcileInstallationOperations(machineDir);
    const recovered = getInstallationOperation(created.id, machineDir)!;
    expect(recovered.status).toBe("interrupted");
    expect(recovered.phase).toBe("interrupted");
    expect(recovered.error).toMatch(/interrupted/i);
  });
});
