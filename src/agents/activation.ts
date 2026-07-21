import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { probeAgent } from "../acp/probe.js";
import type { EventBus } from "../daemon/bus.js";
import { publishInstallationOperationUpdated } from "../daemon/bus.js";
import {
  getInstallationByIdentity,
  getInstallationOperation,
  getInstalledAgent,
  listInstallationOperations,
  setAgentReadiness,
  setInstallationActivation,
} from "./store.js";
import type { InstalledAgent, InstallationOperation } from "./types.js";

const activeActivations = new Map<string, Promise<InstalledAgent>>();

function activationKey(agent: InstalledAgent): string {
  return `${agent.id}@${agent.version}:${agent.installation_id}`;
}

function publish(bus: EventBus | undefined, operationId: string, machineDir?: string): void {
  if (bus) publishInstallationOperationUpdated(bus, getInstallationOperation(operationId, machineDir));
}

function activationFailure(agent: InstalledAgent, error: string): { code: string; action: string } {
  if ((agent.launch.command === "npx" || agent.launch.command === "uvx") && error.includes("command not found")) {
    return {
      code: "host_prerequisite_missing",
      action: `Install ${agent.launch.command} on the Marshal host, then retry the readiness check. The ${agent.id} package does not need to be installed globally.`,
    };
  }
  if (error.includes("ACP protocol mismatch")) {
    return { code: "acp_incompatible", action: "Install a compatible agent version or report the protocol mismatch to the agent maintainer." };
  }
  if (error.includes("timed out")) {
    return { code: "activation_timeout", action: "Check the agent installation and host prerequisites, then retry the readiness check." };
  }
  if (error.includes("command not found")) {
    return { code: "installation_launch_failed", action: "Verify the Marshal-owned installation, then retry the readiness check." };
  }
  return { code: "agent_activation_failed", action: "Review the setup diagnostic and retry the readiness check." };
}

function operationFor(agent: InstalledAgent, operationId: string | undefined, machineDir?: string): InstallationOperation | undefined {
  if (operationId) return getInstallationOperation(operationId, machineDir);
  return getInstallationByIdentity(agent.id, agent.version, agent.distribution, agent.installation_id, machineDir);
}

export async function activateInstalledAgent(
  agentId: string,
  version: string,
  machineDir?: string,
  bus?: EventBus,
  operationId?: string,
  installationId?: string,
  workspace?: string,
): Promise<InstalledAgent> {
  const installed = getInstalledAgent(agentId, version, machineDir, installationId);
  if (!installed || installed.status !== "installed") throw new Error("Only an installed agent can be activated");
  const key = activationKey(installed);
  const active = activeActivations.get(key);
  if (active) return active;

  const activation = runActivation(installed, machineDir, bus, operationFor(installed, operationId, machineDir), workspace);
  activeActivations.set(key, activation);
  try {
    return await activation;
  } finally {
    activeActivations.delete(key);
  }
}

async function runActivation(
  installed: InstalledAgent,
  machineDir: string | undefined,
  bus: EventBus | undefined,
  operation: InstallationOperation | undefined,
  probeCwd?: string,
): Promise<InstalledAgent> {
  if (operation) {
    setInstallationActivation(operation.id, "checking", machineDir);
    publish(bus, operation.id, machineDir);
  }
  let probeWorkspace: string | undefined;
  try {
    const started = new Date().toISOString();
    setAgentReadiness(installed.id, installed.version, {
      readiness_status: "probing",
      readiness_error: null,
      protocol_version: installed.protocol_version,
      capabilities: installed.capabilities,
      auth_methods: installed.auth_methods,
      raw_initialize: installed.raw_initialize,
      probed_at: started,
    }, machineDir, installed.installation_id);
    probeWorkspace = probeCwd ?? mkdtempSync(resolve(tmpdir(), "marshal-probe-"));
    const result = await probeAgent(probeWorkspace, installed.launch);
    const agent = setAgentReadiness(installed.id, installed.version, {
      readiness_status: result.status,
      readiness_error: result.error,
      protocol_version: result.protocol_version,
      capabilities: result.capabilities,
      auth_methods: result.auth_methods,
      raw_initialize: result.raw_initialize,
      probed_at: new Date().toISOString(),
    }, machineDir, installed.installation_id);
    if (operation) {
      const status = result.status === "ready" ? "ready" : result.status === "authentication_required" ? "authentication_required" : "failed";
      const failure = result.status === "failed" ? activationFailure(installed, result.error ?? "Agent activation failed") : null;
      setInstallationActivation(operation.id, status, machineDir, failure ? {
        error: result.error,
        code: failure.code,
        diagnostic: { message: result.error ?? "Agent activation failed", action: failure.action },
      } : {});
      publish(bus, operation.id, machineDir);
    }
    return agent;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failure = activationFailure(installed, message);
    const agent = setAgentReadiness(installed.id, installed.version, {
      readiness_status: "failed",
      readiness_error: message,
      protocol_version: null,
      capabilities: null,
      auth_methods: [],
      raw_initialize: null,
      probed_at: new Date().toISOString(),
    }, machineDir, installed.installation_id);
    if (operation) {
      setInstallationActivation(operation.id, "failed", machineDir, {
        error: message,
        code: failure.code,
        diagnostic: { message, action: failure.action },
      });
      publish(bus, operation.id, machineDir);
    }
    return agent;
  } finally {
    if (!probeCwd && probeWorkspace) rmSync(probeWorkspace, { recursive: true, force: true });
  }
}

export function reconcileAgentActivations(machineDir?: string, bus?: EventBus): void {
  for (const operation of listInstallationOperations(machineDir)) {
    if (operation.status !== "installed" || !["not_started", "checking", "interrupted"].includes(operation.activation_status)) continue;
    const agent = getInstalledAgent(operation.agent_id, operation.version, machineDir, operation.installation_id);
    if (!agent || agent.status !== "installed") continue;
    void activateInstalledAgent(agent.id, agent.version, machineDir, bus, operation.id, agent.installation_id).catch(() => undefined);
  }
}
