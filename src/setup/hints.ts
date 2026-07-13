// Advisory install/auth hints consulted only by the onboarding preflight
// (`marshal init` / `marshal doctor`). This is NOT a runtime allowlist: ADR-019
// keeps the agent-id model open, and the adapter passes any id straight through
// to ACPX. Adding an entry here just makes `init` able to offer an install
// command and point at docs; omitting it means `init` says "install manually".

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

// Expected provider auth env vars per well-known agent family. Presence-only
// check; absence is a guaranteed failure, presence is not validity.
export const AGENT_AUTH_ENV: Record<string, string[]> = {
  opencode: ["OPENAI_API_KEY"],
  pi: ["ANTHROPIC_API_KEY"],
  "claude-code": ["ANTHROPIC_API_KEY"],
  codex: ["OPENAI_API_KEY"],
};

export const PROVIDER_KEY_LINKS: Record<string, string> = {
  OPENAI_API_KEY: "https://platform.openai.com/api-keys",
  ANTHROPIC_API_KEY: "https://console.anthropic.com/settings/keys",
};
