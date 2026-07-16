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
  | { type: "error"; message: string; code?: number };

export interface SpawnOptions {
  permissionMode?: "approve-all" | "approve-reads" | "deny-all" | "interactive";
  onPermission?: (request: AgentPermissionRequest) => Promise<string | undefined>;
  timeoutSeconds?: number;
  model?: string;
  systemPrompt?: string;
  extraArgs?: string[];
  sessionName?: string;
}

export interface PromptOptions extends SpawnOptions {
  noWait?: boolean;
}

export interface Agent {
  spawn(cwd: string, agentId: AgentId, opts?: SpawnOptions): Promise<AgentSession>;
  prompt(session: AgentSession, prompt: string | AgentPromptPart[], opts?: PromptOptions): AsyncIterable<AgentEvent>;
  cancel(session: AgentSession): Promise<void>;
  close(session: AgentSession): Promise<void>;
}
