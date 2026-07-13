// Advisory install hints consulted only by the onboarding preflight
// (`marshal init` / `marshal doctor`). This is NOT a runtime allowlist: ADR-019
// keeps the agent-id model open, and the adapter passes any id straight through
// to ACPX. Adding an entry here just makes `init` able to offer an install
// command and point at docs; omitting it means `init` says "install manually".
//
// The table mirrors the ACPX built-in registry (https://acpx.sh/agents.html).
// Per ADR-023 Decision 5, `acpxCommand` is the exact adapter command ACPX runs
// for the agent — surfacing it in diagnostics lets the user debug a missing
// binary without guessing what ACPX is trying to invoke. Agents not in this
// table are still usable (`AgentId` is `string` per ADR-019); `init` falls back
// to "install manually per your agent's docs" wording and a generic ACPX docs
// link for unknown ids.
//
// Per ADR-022, Marshal does NOT track provider auth env vars. The authoritative
// "can this agent run" signal is the ACP handshake probe in `checkAgentHandshake`
// (`src/setup/preflight.ts`). Any provider key names found anywhere else in
// this file are a regression of that decision.

export interface AgentInstallHint {
  acpxCommand: string;
  docs: string;
}

export const AGENT_INSTALL_HINTS: Record<string, AgentInstallHint> = {
  pi: { acpxCommand: "npx pi-acp", docs: "https://github.com/mariozechner/pi" },
  openclaw: { acpxCommand: "openclaw acp", docs: "https://github.com/openclaw/openclaw" },
  codex: { acpxCommand: "npx -y @agentclientprotocol/codex-acp", docs: "https://codex.openai.com" },
  claude: {
    acpxCommand: "npx -y @agentclientprotocol/claude-agent-acp",
    docs: "https://docs.anthropic.com/claude-code",
  },
  gemini: { acpxCommand: "gemini --acp", docs: "https://github.com/google/gemini-cli" },
  cursor: { acpxCommand: "cursor-agent acp", docs: "https://cursor.com/docs/cli/acp" },
  copilot: {
    acpxCommand: "copilot --acp --stdio",
    docs: "https://docs.github.com/copilot/how-tos/copilot-chat/use-copilot-chat-in-the-command-line",
  },
  droid: { acpxCommand: "droid exec --output-format acp", docs: "https://www.factory.ai" },
  "fast-agent": { acpxCommand: "uvx fast-agent-mcp acp", docs: "https://fast-agent.ai/" },
  "grok-build": { acpxCommand: "grok agent stdio", docs: "https://docs.x.ai/build/overview" },
  iflow: { acpxCommand: "iflow --experimental-acp", docs: "https://github.com/iflow-ai/iflow-cli" },
  kilocode: { acpxCommand: "npx -y @kilocode/cli acp", docs: "https://kilocode.ai" },
  kimi: { acpxCommand: "kimi acp", docs: "https://github.com/MoonshotAI/kimi-cli" },
  kiro: { acpxCommand: "kiro-cli-chat acp", docs: "https://kiro.dev" },
  mux: { acpxCommand: "npx -y mux@^0.27.0 acp", docs: "https://mux.coder.com" },
  opencode: { acpxCommand: "npx -y opencode-ai acp", docs: "https://opencode.ai" },
  qoder: { acpxCommand: "qodercli --acp", docs: "https://docs.qoder.com/cli/acp" },
  qwen: { acpxCommand: "qwen --acp", docs: "https://github.com/QwenLM/qwen-code" },
  trae: { acpxCommand: "traecli acp serve", docs: "https://docs.trae.cn/cli" },
};

// Fallback docs URL surfaced by the handshake probe when no install hint is
// registered for the agent. The agent's own auth config owns the diagnostic;
// Marshal only points at the protocol layer.
export const ACPX_AUTH_DOCS = "https://acpx.sh/agents.html";
