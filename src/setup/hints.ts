// Advisory install hints consulted only by the onboarding preflight
// (`marshal init` / `marshal doctor`). This is NOT a runtime allowlist: ADR-019
// keeps the agent-id model open, and the adapter passes any id straight through
// to ACPX. Adding an entry here just makes `init` able to offer an install
// command and point at docs; omitting it means `init` says "install manually".
//
// Per ADR-022, Marshal does NOT track provider auth env vars. The authoritative
// "can this agent run" signal is the ACP handshake probe in `checkAgentHandshake`
// (`src/setup/preflight.ts`). Any provider key names found anywhere else in
// this file are a regression of that decision.

export interface AgentInstallHint {
  pkg: string;
  docs: string;
}

export const AGENT_INSTALL_HINTS: Record<string, AgentInstallHint> = {
  opencode: { pkg: "opencode-ai", docs: "https://github.com/nicholasgriffintn/opencode" },
  pi: { pkg: "@anthropic-ai/pi-acp", docs: "https://github.com/anthropics/pi" },
  "claude-code": {
    pkg: "@anthropic-ai/claude-code-acp",
    docs: "https://docs.anthropic.com/claude-code",
  },
  codex: { pkg: "@openai/codex-acp", docs: "https://github.com/openai/codex" },
};

// Fallback docs URL surfaced by the handshake probe when no install hint is
// registered for the agent. The agent's own auth config owns the diagnostic;
// Marshal only points at the protocol layer.
export const ACPX_AUTH_DOCS = "https://github.com/openclaw/acpx";
