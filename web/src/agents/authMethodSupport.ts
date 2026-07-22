import type { AgentAuthMethod } from "../types";

export type AuthMethodSupport = { supported: true } | { supported: false; reason: string };

export function authMethodSupport(method: AgentAuthMethod): AuthMethodSupport {
  if (method.type === "agent" || method.type === "env_var") return { supported: true };
  if (method.type === "terminal") return Array.isArray(method.args) && method.args.every((arg) => typeof arg === "string") && method.env != null && Object.values(method.env).every((value) => typeof value === "string") ? { supported: true } : { supported: false, reason: "The advertised terminal metadata is invalid." };
  return { supported: false, reason: `Marshal does not support the advertised method type “${method.type}”.` };
}
