export type AgentId = "opencode" | "pi";

export interface AgentSession {
  agentId: AgentId;
  cwd: string;
  name: string;
  recordId?: string;
}

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; title: string; status?: string; output?: string }
  | { type: "permission"; tool: string; granted: boolean }
  | { type: "log"; stream: "stdout" | "stderr"; text: string }
  | { type: "done"; stopReason: string }
  | { type: "error"; message: string; code?: number };

export interface SpawnOptions {
  permissionMode?: "approve-all" | "approve-reads" | "deny-all";
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
  prompt(session: AgentSession, text: string, opts?: PromptOptions): AsyncIterable<AgentEvent>;
  cancel(session: AgentSession): Promise<void>;
  close(session: AgentSession): Promise<void>;
}
