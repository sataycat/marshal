import type { AgentCapabilities, AgentAuthMethod } from "../agents/types.js";

export interface ReadinessResult {
  status: "ready" | "authentication_required" | "failed";
  protocol_version: number | null;
  capabilities: AgentCapabilities | null;
  auth_methods: AgentAuthMethod[];
  raw_initialize: Record<string, unknown> | null;
  error: string | null;
}
