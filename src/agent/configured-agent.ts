import { loadGlobalConfig, resolveAgentCommand, type AgentRole } from "../worktree/config.js";
import { SdkAcpAgentAdapter } from "./sdk-adapter.js";
import type { Agent } from "./types.js";

export function createConfiguredAgent(role: AgentRole): Agent {
  const config = loadGlobalConfig();
  const command = resolveAgentCommand(role, config);
  return new SdkAcpAgentAdapter({ commands: [command] });
}
