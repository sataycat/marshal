import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { clearDefaultInstalledAgent, createInstallation, executeAgentRemoval, finishInstallation, getAgentRemovalOperation, getInstalledAgent, listInstalledAgents, removeInstalledAgent, resolveInstalledAgentLaunch, setAgentReadiness, setDefaultInstalledAgent } from "./store.js";
import { createSession, updateSession } from "../acp/supervisor-store.js";
import { beginAgentAuthentication } from "./store.js";
import { registerRepository } from "../repositories/store.js";
import { listWorkflowProfiles, saveWorkflowProfile } from "../workflows/store.js";

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

  function installation(machineDir: string, installationId = "remove-install", root = join(machineDir, "agents", "demo", "1.0.0", installationId)): void {
    createInstallation({ id: "demo", version: "1.0.0", source: "registry", license: "MIT", distribution: "npx", package_specifier: "demo@1.0.0", launch: { command: "npx", args: ["demo@1.0.0"] }, registry_snapshot_fetched_at: "snapshot", integrity_status: "not_applicable", status: "installing", readiness_status: "unknown", readiness_error: null, protocol_version: null, capabilities: null, auth_methods: [], raw_initialize: null, probed_at: null, installation_id: installationId, installation_root: root }, `install-${installationId}`, machineDir);
    finishInstallation(`install-${installationId}`, "installed", null, machineDir);
  }

  it("blocks active and recoverable ACP sessions with actionable references", () => {
    const machineDir = mkdtempSync(`${tmpdir()}/marshal-removal-session-`); const root = mkdtempSync(`${tmpdir()}/marshal-removal-repo-`); execFileSync("git", ["init", "-q", root]);
    installation(machineDir); const repository = registerRepository(root, machineDir); listWorkflowProfiles(repository.id, machineDir);
    const active = createSession({ ownerType: "thread", ownerId: "active", agentId: "demo", agentVersion: "1.0.0" }, root);
    const recoverable = createSession({ ownerType: "thread", ownerId: "recoverable", agentId: "demo", agentVersion: "1.0.0" }, root); updateSession(recoverable.id, { status: "recoverable" }, root);
    const operation = removeInstalledAgent("demo", "1.0.0", machineDir);
    expect(operation).toMatchObject({ status: "blocked", error_code: "agent_removal_conflict" });
    expect(operation.references).toEqual(expect.arrayContaining([{ type: "active_session", id: active.id, detail: expect.stringContaining("close") }, { type: "recoverable_session", id: recoverable.id, detail: expect.stringContaining("resolve") }]));
    expect(repository.id).toBeTruthy();
  });

  it("blocks workflow assignments, defaults, authentication, and installation operations", () => {
    const machineDir = mkdtempSync(`${tmpdir()}/marshal-removal-live-`); const root = mkdtempSync(`${tmpdir()}/marshal-removal-workflow-`); execFileSync("git", ["init", "-q", root]);
    installation(machineDir); setAgentReadiness("demo", "1.0.0", { readiness_status: "ready", readiness_error: null, protocol_version: 1, capabilities: { prompt: { text: true, image: false, audio: false, embedded_context: false }, session: { close: true, list: false, load: false, fork: false, resume: false }, load_session: false, auth: { logout: false } }, auth_methods: [], raw_initialize: {}, probed_at: new Date().toISOString() }, machineDir); const repository = registerRepository(root, machineDir); listWorkflowProfiles(repository.id, machineDir);
    saveWorkflowProfile(repository.id, { name: "Default", permission_policy: "allow_reads_ask_writes", unattended_authorized: false, timeout_ms: 1000, max_retries: 0, verification_commands: [], require_decorrelated_builder_validator: false, assignments: [{ role: "builder", agent_id: "demo", agent_version: "1.0.0" }] }, undefined, machineDir);
    beginAgentAuthentication({ id: "auth-1", agent_id: "demo", version: "1.0.0", method_id: "login", method_name: "Login" }, machineDir);
    installation(machineDir, "installing-install");
    createInstallation({ id: "demo", version: "1.0.0", source: "registry", license: "MIT", distribution: "npx", package_specifier: "demo@1.0.0", launch: { command: "npx", args: ["demo@1.0.0"] }, registry_snapshot_fetched_at: "snapshot", integrity_status: "not_applicable", status: "installing", readiness_status: "unknown", readiness_error: null, protocol_version: null, capabilities: null, auth_methods: [], raw_initialize: null, probed_at: null, installation_id: "installing-install" }, "active-install-op", machineDir);
    const operation = removeInstalledAgent("demo", "1.0.0", machineDir, "remove-install");
    expect(operation.error_code).toBe("agent_removal_conflict");
    expect(operation.references.map((reference) => reference.type)).toEqual(expect.arrayContaining(["workflow_assignment", "default", "authentication"]));
    expect(removeInstalledAgent("demo", "1.0.0", machineDir, "installing-install").references.map((reference) => reference.type)).toContain("installation");
  });

  it("cleans only the owned payload, records a tombstone, and is idempotent", () => {
    const machineDir = mkdtempSync(`${tmpdir()}/marshal-removal-cleanup-`); const root = join(machineDir, "agents", "demo", "1.0.0", "owned");
    installation(machineDir, "owned-install", root); clearDefaultInstalledAgent("demo", "owned-install", machineDir);
    execFileSync("mkdir", ["-p", root]); execFileSync("touch", [join(root, "payload.bin")]);
    const first = removeInstalledAgent("demo", "1.0.0", machineDir, "owned-install");
    expect(first.status).toBe("completed"); expect(getInstalledAgent("demo", "1.0.0", machineDir, "owned-install")).toBeUndefined(); expect(getAgentRemovalOperation(first.id, machineDir)).toMatchObject({ status: "completed" });
    expect(() => execFileSync("test", ["!", "-e", root])).not.toThrow();
    expect(removeInstalledAgent("demo", "1.0.0", machineDir, "owned-install").id).toBe(first.id);
  });

  it("retains a failed cleanup operation for retry", () => {
    const machineDir = mkdtempSync(`${tmpdir()}/marshal-removal-failure-`); installation(machineDir, "bad-install", "/tmp/not-owned-by-marshal"); clearDefaultInstalledAgent("demo", "bad-install", machineDir);
    const failed = removeInstalledAgent("demo", "1.0.0", machineDir, "bad-install");
    expect(failed).toMatchObject({ status: "failed", error_code: "agent_cleanup_failed" });
    expect(executeAgentRemoval(failed.id, machineDir)).toMatchObject({ id: failed.id, status: "failed" });
  });
});
