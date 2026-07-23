import type { StructuredAcpError } from "../acp/errors.js";

export type AgentId = string;

export interface AgentCommand {
  id: AgentId;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface AgentSession {
  agentId: AgentId;
  cwd: string;
  name: string;
  recordId?: string;
  supportsImages?: boolean;
  configOptions?: AgentSessionConfigOption[];
  modes?: AgentSessionModeState | null;
}

export interface AgentSessionConfigValue {
  value: string;
  name: string;
  description?: string | null;
}

export interface AgentSessionConfigGroup {
  group: string;
  name: string;
  options: AgentSessionConfigValue[];
}

export type AgentSessionConfigOption = {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
} & (
  | {
      type: "select";
      currentValue: string;
      options: AgentSessionConfigValue[] | AgentSessionConfigGroup[];
    }
  | { type: "boolean"; currentValue: boolean }
);

export interface AgentSessionModeState {
  currentModeId: string;
  availableModes: Array<{ id: string; name: string; description?: string | null }>;
}

export type AgentPromptPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface AgentPermissionRequest {
  requestId: string;
  sessionId: string;
  tool: string;
  kind?: string | null;
  rawInput?: unknown;
  options: PermissionOption[];
}

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; title: string; status?: string; output?: string }
  | { type: "permission"; tool: string; granted: boolean; requestId?: string }
  | { type: "log"; stream: "stdout" | "stderr"; text: string }
  | { type: "done"; stopReason: string }
  | { type: "error"; message: string; code?: number; failure?: StructuredAcpError };

export interface SpawnOptions {
  permissionMode?: "approve-all" | "approve-reads" | "deny-all" | "interactive";
  onPermission?: (request: AgentPermissionRequest) => Promise<string | undefined>;
  timeoutSeconds?: number;
  model?: string;
  systemPrompt?: string;
  extraArgs?: string[];
  sessionName?: string;
  onSessionConfiguration?: (configuration: {
    configOptions: AgentSessionConfigOption[];
    modes: AgentSessionModeState | null;
  }) => void;
}

export interface PromptOptions extends SpawnOptions {
  noWait?: boolean;
}

export interface Agent {
  spawn(cwd: string, agentId: AgentId, opts?: SpawnOptions): Promise<AgentSession>;
  prompt(
    session: AgentSession,
    prompt: string | AgentPromptPart[],
    opts?: PromptOptions,
  ): AsyncIterable<AgentEvent>;
  setConfigOption?(
    session: AgentSession,
    configId: string,
    value: string | boolean,
  ): Promise<AgentSessionConfigOption[]>;
  setMode?(session: AgentSession, modeId: string): Promise<AgentSessionModeState | null>;
  cancel(session: AgentSession): Promise<void>;
  close(session: AgentSession): Promise<void>;
}
