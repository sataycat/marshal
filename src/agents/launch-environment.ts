import type { AgentLaunchSpec, InstalledAgent } from "./types.js";
import { resolveAgentCredentialValues, type CredentialStore } from "./credentials.js";

export interface ResolveLaunchEnvironmentOptions {
  hostEnv?: NodeJS.ProcessEnv;
  additionalEnv?: Record<string, string>;
  credentialStore?: CredentialStore;
}

export function permittedHostEnvironment(hostEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(Object.entries(hostEnv).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export function resolveAgentLaunchEnvironment(
  installation: Pick<InstalledAgent, "installation_id" | "launch">,
  machineDir?: string,
  options: ResolveLaunchEnvironmentOptions = {},
): Record<string, string> {
  return {
    ...permittedHostEnvironment(options.hostEnv),
    ...(installation.launch.env ?? {}),
    ...resolveAgentCredentialValues(installation.installation_id, machineDir, options.credentialStore),
    ...(options.additionalEnv ?? {}),
  };
}

export function launchWithResolvedEnvironment(
  installation: Pick<InstalledAgent, "installation_id" | "launch">,
  machineDir?: string,
  options: ResolveLaunchEnvironmentOptions = {},
): AgentLaunchSpec {
  return { ...installation.launch, env: resolveAgentLaunchEnvironment(installation, machineDir, options) };
}
