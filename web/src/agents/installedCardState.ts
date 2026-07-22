import type { AgentAuthenticationStatus, AgentReadinessStatus, InstalledAgentStatus } from "../types";

export type InstalledCardState = "getting_ready" | "ready" | "sign_in_required" | "setup_needed" | "signing_in";

export function installedCardState(status: InstalledAgentStatus, readiness: AgentReadinessStatus, authentication?: AgentAuthenticationStatus | null): InstalledCardState {
  if (authentication === "authenticating") return "signing_in";
  if (status === "installing" || readiness === "probing" || readiness === "unknown") return "getting_ready";
  if (status !== "installed" || readiness === "failed") return "setup_needed";
  if (readiness === "authentication_required") return "sign_in_required";
  return "ready";
}

export function installedCardStateLabel(state: InstalledCardState): string {
  if (state === "getting_ready") return "Getting agent ready";
  if (state === "ready") return "Ready to use";
  if (state === "sign_in_required") return "Sign-in required";
  if (state === "signing_in") return "Signing in";
  return "Setup needed";
}
