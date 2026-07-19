import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createInstallation, finishInstallation, getInstalledAgent, resolveInstalledAgentLaunch, setDefaultInstalledAgent } from "./store.js";

describe("installed agent storage", () => {
  it("preserves agent identity/version references and generalized npx provenance", () => {
    const machineDir = mkdtempSync(`${tmpdir()}/marshal-agents-`);
    createInstallation({ id: "demo", version: "1.2.3", source: "registry", license: "MIT", distribution: "npx", package_specifier: "demo@1.2.3", launch: { command: "npx", args: ["--yes", "demo@1.2.3"] }, registry_snapshot_fetched_at: "snapshot", integrity_status: "not_applicable", status: "installing", readiness_status: "unknown", readiness_error: null, protocol_version: null, capabilities: null, auth_methods: [], raw_initialize: null, probed_at: null }, "op", machineDir);
    finishInstallation("op", "installed", null, machineDir);
    const installed = getInstalledAgent("demo", "1.2.3", machineDir)!;
    expect(installed.provenance).toMatchObject({ exact_version: "1.2.3", distribution: "npx", package_specifier: "demo@1.2.3" });
    expect(installed.installation_id).toBe("demo@1.2.3");
    expect(resolveInstalledAgentLaunch("demo", "1.2.3", machineDir)).toEqual({ command: "npx", args: ["--yes", "demo@1.2.3"] });
  });

  it("keeps side-by-side installations launchable and changes only the default", () => {
    const machineDir = mkdtempSync(`${tmpdir()}/marshal-side-by-side-`);
    for (const [op, installationId, distribution] of [["old", "old-install", "npx"], ["new", "new-install", "uvx"]] as const) {
      createInstallation({ id: "demo", version: "1.2.3", source: "registry", license: "MIT", distribution, package_specifier: `${distribution}-pin`, launch: { command: distribution, args: [installationId] }, registry_snapshot_fetched_at: "snapshot", integrity_status: "not_applicable", status: "installing", readiness_status: "unknown", readiness_error: null, protocol_version: null, capabilities: null, auth_methods: [], raw_initialize: null, probed_at: null, installation_id: installationId }, op, machineDir);
      finishInstallation(op, "installed", null, machineDir);
    }
    expect(resolveInstalledAgentLaunch("demo", "1.2.3", machineDir)).toEqual({ command: "npx", args: ["old-install"] });
    setDefaultInstalledAgent("demo", "new-install", machineDir);
    expect(resolveInstalledAgentLaunch("demo", "1.2.3", machineDir)).toEqual({ command: "uvx", args: ["new-install"] });
    expect(getInstalledAgent("demo", "1.2.3", machineDir, "old-install")?.is_default).toBe(false);
  });
});
