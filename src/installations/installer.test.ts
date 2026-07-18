import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { exactUvxPackage, selectDistribution, startInstallation } from "./installer.js";
import { getInstalledAgent } from "../agents/store.js";
import type { RegistryAgent } from "../registry/types.js";

const uvxAgent: RegistryAgent = {
  id: "uv-agent", name: "UV Agent", version: "1.2.3", description: "fixture", license: "MIT", authors: [],
  distributions: [{ kind: "uvx", package: "uv-agent==1.2.3", args: ["acp"] }],
};

describe("uvx installations", () => {
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
});
