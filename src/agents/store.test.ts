import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  clearDefaultInstalledAgent,
  createInstallation,
  executeAgentRemoval,
  finishInstallation,
  getAgentAuthenticationOperation,
  getAgentRemovalOperation,
  getInstalledAgent,
  getInstallationOperation,
  listInstalledAgents,
  removeInstalledAgent,
  resolveInstalledAgentLaunch,
  setAgentReadiness,
  setDefaultInstalledAgent,
  setInstallationActivation,
} from "./store.js";
import { createSession, updateSession } from "../acp/supervisor-store.js";
import { beginAgentAuthentication } from "./store.js";
import { registerRepository } from "../repositories/store.js";
import { listWorkflowProfiles, saveWorkflowProfile } from "../workflows/store.js";
import { machineDbPath } from "../storage/machine.js";

describe("installed agent storage", () => {
  it("migrates legacy installation tables for identity upserts", () => {
    const machineDir = mkdtempSync(`${tmpdir()}/marshal-agents-legacy-`);
    const db = new Database(machineDbPath(machineDir));
    db.exec(`
      CREATE TABLE installed_agents (
        id TEXT NOT NULL,
        version TEXT NOT NULL,
        source TEXT NOT NULL,
        license TEXT NOT NULL,
        distribution TEXT NOT NULL,
        package_specifier TEXT NOT NULL,
        launch TEXT NOT NULL,
        registry_snapshot_fetched_at TEXT NOT NULL,
        integrity_status TEXT NOT NULL,
        installation_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        failure TEXT,
        PRIMARY KEY (id, version)
      )
    `);
    db.close();

    createInstallation(
      {
        id: "legacy",
        version: "1.0.0",
        source: "registry",
        license: "MIT",
        distribution: "npx",
        package_specifier: "legacy@1.0.0",
        launch: { command: "npx", args: ["legacy@1.0.0"] },
        registry_snapshot_fetched_at: "snapshot",
        integrity_status: "not_applicable",
        status: "installing",
        readiness_status: "unknown",
        readiness_error: null,
        protocol_version: null,
        capabilities: null,
        auth_methods: [],
        raw_initialize: null,
        probed_at: null,
        installation_id: "legacy-install",
      },
      "legacy-op",
      machineDir,
    );

    expect(listInstalledAgents(machineDir)).toHaveLength(1);
  });

  it("preserves agent identity/version references and generalized npx provenance", () => {
    const machineDir = mkdtempSync(`${tmpdir()}/marshal-agents-`);
    createInstallation(
      {
        id: "demo",
        version: "1.2.3",
        source: "registry",
        license: "MIT",
        distribution: "npx",
        package_specifier: "demo@1.2.3",
        launch: { command: "npx", args: ["--yes", "demo@1.2.3"] },
        registry_snapshot_fetched_at: "snapshot",
        integrity_status: "not_applicable",
        status: "installing",
        readiness_status: "unknown",
        readiness_error: null,
        protocol_version: null,
        capabilities: null,
        auth_methods: [],
        raw_initialize: null,
        probed_at: null,
      },
      "op",
      machineDir,
    );
    finishInstallation("op", "installed", null, machineDir);
    const installed = getInstalledAgent("demo", "1.2.3", machineDir)!;
    expect(installed.provenance).toMatchObject({
      exact_version: "1.2.3",
      distribution: "npx",
      package_specifier: "demo@1.2.3",
    });
    expect(installed.installation_id).toBe("demo@1.2.3");
    expect(resolveInstalledAgentLaunch("demo", "1.2.3", machineDir)).toEqual({
      command: "npx",
      args: ["--yes", "demo@1.2.3"],
    });
  });

  it("persists guided activation state independently from installation state", () => {
    const machineDir = mkdtempSync(`${tmpdir()}/marshal-agent-activation-state-`);
    const operation = createInstallation(
      {
        id: "activation",
        version: "1.0.0",
        source: "registry",
        license: "MIT",
        distribution: "npx",
        package_specifier: "activation@1.0.0",
        launch: { command: "npx", args: ["activation@1.0.0"] },
        registry_snapshot_fetched_at: "snapshot",
        integrity_status: "not_applicable",
        status: "installing",
        readiness_status: "unknown",
        readiness_error: null,
        protocol_version: null,
        capabilities: null,
        auth_methods: [],
        raw_initialize: null,
        probed_at: null,
      },
      "activation-op",
      machineDir,
    );
    finishInstallation(operation.id, "installed", null, machineDir);
    setInstallationActivation(operation.id, "checking", machineDir);
    expect(getInstallationOperation(operation.id, machineDir)).toMatchObject({
      status: "installed",
      activation_status: "checking",
    });
    setInstallationActivation(operation.id, "failed", machineDir, {
      error: "npx missing",
      code: "host_prerequisite_missing",
      diagnostic: { message: "npx missing", action: "Install npx" },
    });
    expect(getInstallationOperation(operation.id, machineDir)).toMatchObject({
      status: "installed",
      activation_status: "failed",
      activation_error_code: "host_prerequisite_missing",
      activation_diagnostic: { action: "Install npx" },
    });
  });

  it("keeps side-by-side installations launchable and changes only the default", () => {
    const machineDir = mkdtempSync(`${tmpdir()}/marshal-side-by-side-`);
    for (const [op, installationId, distribution] of [
      ["old", "old-install", "npx"],
      ["new", "new-install", "uvx"],
    ] as const) {
      createInstallation(
        {
          id: "demo",
          version: "1.2.3",
          source: "registry",
          license: "MIT",
          distribution,
          package_specifier: `${distribution}-pin`,
          launch: { command: distribution, args: [installationId] },
          registry_snapshot_fetched_at: "snapshot",
          integrity_status: "not_applicable",
          status: "installing",
          readiness_status: "unknown",
          readiness_error: null,
          protocol_version: null,
          capabilities: null,
          auth_methods: [],
          raw_initialize: null,
          probed_at: null,
          installation_id: installationId,
        },
        op,
        machineDir,
      );
      finishInstallation(op, "installed", null, machineDir);
    }
    expect(resolveInstalledAgentLaunch("demo", "1.2.3", machineDir)).toEqual({
      command: "npx",
      args: ["old-install"],
    });
    setDefaultInstalledAgent("demo", "new-install", machineDir);
    expect(resolveInstalledAgentLaunch("demo", "1.2.3", machineDir)).toEqual({
      command: "uvx",
      args: ["new-install"],
    });
    expect(getInstalledAgent("demo", "1.2.3", machineDir, "old-install")?.is_default).toBe(false);
  });

  function installation(
    machineDir: string,
    installationId = "remove-install",
    root = join(machineDir, "agents", "demo", "1.0.0", installationId),
    operationId = `install-${installationId}`,
  ): void {
    createInstallation(
      {
        id: "demo",
        version: "1.0.0",
        source: "registry",
        license: "MIT",
        distribution: "npx",
        package_specifier: "demo@1.0.0",
        launch: { command: "npx", args: ["demo@1.0.0"] },
        registry_snapshot_fetched_at: "snapshot",
        integrity_status: "not_applicable",
        status: "installing",
        readiness_status: "unknown",
        readiness_error: null,
        protocol_version: null,
        capabilities: null,
        auth_methods: [],
        raw_initialize: null,
        probed_at: null,
        installation_id: installationId,
        installation_root: root,
      },
      operationId,
      machineDir,
    );
    finishInstallation(operationId, "installed", null, machineDir);
  }

  it("blocks active and recoverable ACP sessions with actionable references", () => {
    const machineDir = mkdtempSync(`${tmpdir()}/marshal-removal-session-`);
    const root = mkdtempSync(`${tmpdir()}/marshal-removal-repo-`);
    execFileSync("git", ["init", "-q", root]);
    installation(machineDir);
    const repository = registerRepository(root, machineDir);
    listWorkflowProfiles(repository.id, machineDir);
    const active = createSession(
      { ownerType: "thread", ownerId: "active", agentId: "demo", agentVersion: "1.0.0" },
      root,
    );
    const recoverable = createSession(
      { ownerType: "thread", ownerId: "recoverable", agentId: "demo", agentVersion: "1.0.0" },
      root,
    );
    updateSession(recoverable.id, { status: "recoverable" }, root);
    const operation = removeInstalledAgent("demo", "1.0.0", machineDir);
    expect(operation).toMatchObject({ status: "blocked", error_code: "agent_removal_conflict" });
    expect(operation.references).toEqual(
      expect.arrayContaining([
        { type: "active_session", id: active.id, detail: expect.stringContaining("close") },
        {
          type: "recoverable_session",
          id: recoverable.id,
          detail: expect.stringContaining("resolve"),
        },
      ]),
    );
    expect(repository.id).toBeTruthy();
  });

  it("blocks workflow assignments, authentication, and installation operations", () => {
    const machineDir = mkdtempSync(`${tmpdir()}/marshal-removal-live-`);
    const root = mkdtempSync(`${tmpdir()}/marshal-removal-workflow-`);
    execFileSync("git", ["init", "-q", root]);
    installation(machineDir);
    setAgentReadiness(
      "demo",
      "1.0.0",
      {
        readiness_status: "ready",
        readiness_error: null,
        protocol_version: 1,
        capabilities: {
          prompt: { text: true, image: false, audio: false, embedded_context: false },
          session: { close: true, list: false, load: false, fork: false, resume: false },
          load_session: false,
          auth: { logout: false },
        },
        auth_methods: [],
        raw_initialize: {},
        probed_at: new Date().toISOString(),
      },
      machineDir,
    );
    const repository = registerRepository(root, machineDir);
    listWorkflowProfiles(repository.id, machineDir);
    saveWorkflowProfile(
      repository.id,
      {
        name: "Default",
        permission_policy: "allow_reads_ask_writes",
        unattended_authorized: false,
        timeout_ms: 1000,
        max_retries: 0,
        verification_commands: [],
        require_decorrelated_builder_validator: false,
        assignments: [{ role: "builder", agent_id: "demo", agent_version: "1.0.0" }],
      },
      undefined,
      machineDir,
    );
    beginAgentAuthentication(
      {
        id: "auth-1",
        agent_id: "demo",
        version: "1.0.0",
        installation_id: "remove-install",
        method_id: "login",
        method_name: "Login",
      },
      machineDir,
    );
    installation(machineDir, "installing-install");
    createInstallation(
      {
        id: "demo",
        version: "1.0.0",
        source: "registry",
        license: "MIT",
        distribution: "npx",
        package_specifier: "demo@1.0.0",
        launch: { command: "npx", args: ["demo@1.0.0"] },
        registry_snapshot_fetched_at: "snapshot",
        integrity_status: "not_applicable",
        status: "installing",
        readiness_status: "unknown",
        readiness_error: null,
        protocol_version: null,
        capabilities: null,
        auth_methods: [],
        raw_initialize: null,
        probed_at: null,
        installation_id: "installing-install",
      },
      "active-install-op",
      machineDir,
    );
    const operation = removeInstalledAgent("demo", "1.0.0", machineDir, "remove-install");
    expect(operation.error_code).toBe("agent_removal_conflict");
    expect(operation.references.map((reference) => reference.type)).toEqual(
      expect.arrayContaining(["workflow_assignment", "authentication"]),
    );
    expect(
      removeInstalledAgent("demo", "1.0.0", machineDir, "installing-install").references.map(
        (reference) => reference.type,
      ),
    ).toContain("installation");
  });

  it("keeps authentication operations tied to their installation identity", () => {
    const machineDir = mkdtempSync(`${tmpdir()}/marshal-auth-identity-`);
    installation(machineDir, "first-install");
    installation(machineDir, "second-install");
    const first = beginAgentAuthentication(
      {
        id: "auth-first",
        agent_id: "demo",
        version: "1.0.0",
        installation_id: "first-install",
        method_id: "login",
        method_name: "Login",
      },
      machineDir,
    );
    const second = beginAgentAuthentication(
      {
        id: "auth-second",
        agent_id: "demo",
        version: "1.0.0",
        installation_id: "second-install",
        method_id: "login",
        method_name: "Login",
      },
      machineDir,
    );
    expect(getAgentAuthenticationOperation(first.id, machineDir)?.installation_id).toBe(
      "first-install",
    );
    expect(getAgentAuthenticationOperation(second.id, machineDir)?.installation_id).toBe(
      "second-install",
    );
  });

  it("cleans only the owned payload, records a tombstone, and is idempotent", () => {
    const machineDir = mkdtempSync(`${tmpdir()}/marshal-removal-cleanup-`);
    const root = join(machineDir, "agents", "demo", "1.0.0", "owned");
    installation(machineDir, "owned-install", root);
    clearDefaultInstalledAgent("demo", "owned-install", machineDir);
    execFileSync("mkdir", ["-p", root]);
    execFileSync("touch", [join(root, "payload.bin")]);
    const first = removeInstalledAgent("demo", "1.0.0", machineDir, "owned-install");
    expect(first.status).toBe("completed");
    expect(getInstalledAgent("demo", "1.0.0", machineDir, "owned-install")).toBeUndefined();
    expect(getAgentRemovalOperation(first.id, machineDir)).toMatchObject({ status: "completed" });
    expect(() => execFileSync("test", ["!", "-e", root])).not.toThrow();
    expect(removeInstalledAgent("demo", "1.0.0", machineDir, "owned-install").id).toBe(first.id);
  });

  it("removes the default installation and promotes the newest remaining installation", () => {
    const machineDir = mkdtempSync(`${tmpdir()}/marshal-removal-default-`);
    installation(machineDir, "old-install");
    installation(machineDir, "new-install");
    setDefaultInstalledAgent("demo", "old-install", machineDir);
    const removed = removeInstalledAgent("demo", "1.0.0", machineDir, "old-install");
    expect(removed.status).toBe("completed");
    expect(getInstalledAgent("demo", "1.0.0", machineDir, "new-install")?.is_default).toBe(true);
  });

  it("does not reuse a completed operation after the installation identity is recreated", () => {
    const machineDir = mkdtempSync(`${tmpdir()}/marshal-removal-reinstall-`);
    installation(machineDir, "reused-install");
    const first = removeInstalledAgent("demo", "1.0.0", machineDir, "reused-install");
    expect(first.status).toBe("completed");

    installation(machineDir, "reused-install", undefined, "install-reused-install-again");
    const second = removeInstalledAgent("demo", "1.0.0", machineDir, "reused-install");
    expect(second.status).toBe("completed");
    expect(second.id).not.toBe(first.id);
    expect(getInstalledAgent("demo", "1.0.0", machineDir, "reused-install")).toBeUndefined();
  });

  it("retains a failed cleanup operation for retry", () => {
    const machineDir = mkdtempSync(`${tmpdir()}/marshal-removal-failure-`);
    installation(machineDir, "bad-install", "/tmp/not-owned-by-marshal");
    clearDefaultInstalledAgent("demo", "bad-install", machineDir);
    const failed = removeInstalledAgent("demo", "1.0.0", machineDir, "bad-install");
    expect(failed).toMatchObject({ status: "failed", error_code: "agent_cleanup_failed" });
    expect(executeAgentRemoval(failed.id, machineDir)).toMatchObject({
      id: failed.id,
      status: "failed",
    });
  });
});
