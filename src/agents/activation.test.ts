import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { activateInstalledAgent, reconcileAgentActivations } from "./activation.js";
import { createInstallation, finishInstallation, getInstallationOperation, getInstalledAgent, setInstallationActivation } from "./store.js";

const FAKE_READY_AGENT = `#!/usr/bin/env node
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, agentCapabilities: { sessionCapabilities: { close: {} } }, authMethods: process.env.FAKE_ACTIVATION_AUTH === '1' ? [{ id: 'login', name: 'Browser login' }] : [] } });
  else if (msg.method === 'session/new') process.env.FAKE_ACTIVATION_AUTH_REQUIRED === '1' ? send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Sign in required', data: { methodId: 'login' } } }) : send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'activation-session' } });
  else if (msg.method === 'session/close') send({ jsonrpc: '2.0', id: msg.id, result: {} });
});
`;

let readyAgentPath: string;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "marshal-activation-agent-"));
  readyAgentPath = join(dir, "agent.cjs");
  writeFileSync(readyAgentPath, FAKE_READY_AGENT, { mode: 0o755 });
  chmodSync(readyAgentPath, 0o755);
});

function createInstalled(machineDir: string, operationId: string, installationId: string, command = "node") {
  const operation = createInstallation({
    id: "activation-agent",
    version: "1.0.0",
    source: "registry",
    license: "MIT",
    distribution: "npx",
    package_specifier: "activation-agent@1.0.0",
    launch: { command, args: command === "node" ? [readyAgentPath] : ["/missing/agent"] },
    registry_snapshot_fetched_at: "fixture",
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
  }, operationId, machineDir);
  finishInstallation(operation.id, "installed", null, machineDir);
  return operation;
}

describe("guided agent activation", () => {
  it("probes a published installation and persists ready activation", async () => {
    const machineDir = mkdtempSync(join(tmpdir(), "marshal-activation-ready-"));
    const operation = createInstalled(machineDir, "activation-ready", "ready-install");

    const agent = await activateInstalledAgent("activation-agent", "1.0.0", machineDir, undefined, operation.id, "ready-install");

    expect(agent.readiness_status).toBe("ready");
    expect(getInstallationOperation(operation.id, machineDir)).toMatchObject({
      status: "installed",
      phase: "completed",
      activation_status: "ready",
      activation_error: null,
    });
  });

  it("records an actionable setup failure without changing installation status", async () => {
    const machineDir = mkdtempSync(join(tmpdir(), "marshal-activation-failed-"));
    const operation = createInstalled(machineDir, "activation-failed", "failed-install", "npx");

    const agent = await activateInstalledAgent("activation-agent", "1.0.0", machineDir, undefined, operation.id, "failed-install");

    expect(agent.readiness_status).toBe("failed");
    expect(getInstalledAgent("activation-agent", "1.0.0", machineDir, "failed-install")).toMatchObject({ status: "installed", readiness_status: "failed" });
    expect(getInstallationOperation(operation.id, machineDir)).toMatchObject({
      status: "installed",
      activation_status: "failed",
      activation_error_code: expect.any(String),
      activation_diagnostic: { action: expect.any(String) },
    });
  });

  it("stops at typed sign-in required and keeps initialization metadata durable", async () => {
    const machineDir = mkdtempSync(join(tmpdir(), "marshal-activation-auth-"));
    const operation = createInstalled(machineDir, "activation-auth", "auth-install");
    process.env.FAKE_ACTIVATION_AUTH = "1";
    process.env.FAKE_ACTIVATION_AUTH_REQUIRED = "1";
    try {
      const agent = await activateInstalledAgent("activation-agent", "1.0.0", machineDir, undefined, operation.id, "auth-install");
      expect(agent.readiness_status).toBe("authentication_required");
      expect(agent).toMatchObject({ protocol_version: expect.any(Number), auth_methods: [{ id: "login" }], raw_initialize: { authMethods: [{ id: "login" }] }, readiness_failure: { kind: "authentication_required", protocol_code: -32000, data: { methodId: "login" } } });
      expect(getInstallationOperation(operation.id, machineDir)).toMatchObject({
        status: "installed",
        activation_status: "authentication_required",
        activation_finished_at: expect.any(String),
      });
    } finally {
      delete process.env.FAKE_ACTIVATION_AUTH;
      delete process.env.FAKE_ACTIVATION_AUTH_REQUIRED;
    }
  });

  it("restarts an incomplete activation from durable state", async () => {
    const machineDir = mkdtempSync(join(tmpdir(), "marshal-activation-restart-"));
    const operation = createInstalled(machineDir, "activation-restart", "restart-install");
    setInstallationActivation(operation.id, "checking", machineDir);

    reconcileAgentActivations(machineDir);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (getInstallationOperation(operation.id, machineDir)?.activation_status === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(getInstallationOperation(operation.id, machineDir)).toMatchObject({ activation_status: "ready" });
  });
});
