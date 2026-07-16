import { cwd } from "node:process";
import type { Agent, AgentEvent, AgentSession, SpawnOptions } from "../agent/types.js";
import { createConfiguredAgent } from "../agent/configured-agent.js";
import { logger } from "../logger.js";
import { getTask } from "../tasks/store.js";
import { resolveAgentId } from "../worktree/config.js";
import {
  appendSpecMessage,
  listSpecMessages,
  type SpecMessage,
  type SpecMessageRole,
} from "../tasks/spec-store.js";
import type { AgentId } from "../agent/types.js";

const SPEC_AUTHOR_TIMEOUT_SECONDS = 600;
const SPEC_AUTHOR_PERMISSION_MODE = "approve-reads" as const;
export const DEFAULT_SPEC_CHAT_BUDGET_CHARS = 24_000;

export const MARSHAL_SPEC_FENCE = "marshal-spec";

export interface SpecAuthoringPromptOptions {
  chatBudgetChars?: number;
}

export function renderSpecAuthoringPrompt(
  task: {
    title: string;
    spec_markdown: string;
    status: string;
  },
  history: SpecMessage[],
  options: SpecAuthoringPromptOptions = {},
): string {
  const budget = options.chatBudgetChars ?? DEFAULT_SPEC_CHAT_BUDGET_CHARS;
  const recent = selectRecentHistory(history, budget);

  const historyLines: string[] = [];
  for (const msg of recent) {
    historyLines.push(`### ${msg.role}`);
    historyLines.push(`${msg.content}`);
    historyLines.push("");
  }
  const omitted = history.length - recent.length;

  return [
    "You are helping a human author a task spec for the Marshal system.",
    "The human owns the spec; your job is to ask questions, identify gaps, and propose a tighter spec.",
    "",
    "Rules:",
    "- Ask questions when requirements are ambiguous.",
    "- Identify missing acceptance criteria and edge cases.",
    "- Propose a concise vertical-slice spec the human can ship as one reviewable diff.",
    "- Do not expand the task beyond one mergeable diff.",
    "- Never declare the spec final; the human decides when to update and freeze.",
    "- If you propose a spec revision, include it in a fenced code block with the info string `marshal-spec`, like:",
    "",
    "  ```marshal-spec",
    "  # Goal",
    "  ...",
    "  ```",
    "",
    `Task title: ${task.title}`,
    `Task status: ${task.status}`,
    "",
    "## Current spec draft",
    "",
    task.spec_markdown.trimEnd() || "(empty)",
    "",
    "## Recent chat history",
    "",
    historyLines.length > 0 ? historyLines.join("\n") : "(no messages yet)",
    omitted > 0 ? `\n(${omitted} older message(s) omitted to fit the context budget)\n` : "",
    "Respond conversationally. If you propose a spec revision, wrap only the revised spec in a ```marshal-spec fenced block.",
  ].join("\n");
}

export function selectRecentHistory(history: SpecMessage[], budgetChars: number): SpecMessage[] {
  const recent: SpecMessage[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const msg = history[i];
    const delta = msg.content.length + msg.role.length + 8;
    if (used + delta > budgetChars) break;
    recent.unshift(msg);
    used += delta;
  }
  return recent;
}

export function extractMarshalSpec(text: string): string | null {
  const fence = "```";
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trimStart();
    const fenceMatch = trimmed.match(/^```(.*)$/);
    if (!fenceMatch) {
      i += 1;
      continue;
    }
    const info = fenceMatch[1].trim();
    if (info !== MARSHAL_SPEC_FENCE) {
      i += 1;
      continue;
    }
    const contentLines: string[] = [];
    let j = i + 1;
    let closed = false;
    while (j < lines.length) {
      const body = lines[j];
      const bodyTrim = body.trimStart();
      if (bodyTrim.startsWith(fence)) {
        closed = true;
        break;
      }
      contentLines.push(body);
      j += 1;
    }
    if (!closed) {
      i += 1;
      continue;
    }
    return contentLines.join("\n");
  }
  return null;
}

export function collectAgentText(events: Iterable<AgentEvent>): string {
  let text = "";
  for (const event of events) {
    if (event.type === "text") {
      text += event.text;
    } else if (event.type === "error") {
      throw new Error(event.message);
    }
  }
  return text;
}

export class SpecChatClosedError extends Error {
  constructor(slug: string, status: string) {
    super(`Spec chat is only available for backlog tasks (task ${slug} is ${status})`);
    this.name = "SpecChatClosedError";
  }
}

export interface RunSpecAuthorTurnOptions {
  root?: string;
  agent?: Agent;
  agentId?: AgentId;
  chatBudgetChars?: number;
}

export interface SpecAuthorTurnResult {
  userMessage: SpecMessage;
  assistantMessage: SpecMessage;
}

export async function runSpecAuthorTurn(
  slug: string,
  userContent: string,
  options: RunSpecAuthorTurnOptions = {},
): Promise<SpecAuthorTurnResult> {
  const root = options.root;
  const task = getTask(slug, root);
  if (task.status !== "backlog") {
    throw new SpecChatClosedError(slug, task.status);
  }

  const userMessage = appendSpecMessage(slug, "user", userContent, root);

  const agent = options.agent ?? createConfiguredAgent("specAuthor");
  const agentId: AgentId = options.agentId ?? resolveAgentId("specAuthor");

  const specMessages = listSpecMessages(slug, root);
  const prompt = renderSpecAuthoringPrompt(task, specMessages, {
    chatBudgetChars: options.chatBudgetChars,
  });

  const spawnOpts: SpawnOptions = {
    sessionName: `marshal-${slug}-spec`,
    permissionMode: SPEC_AUTHOR_PERMISSION_MODE,
    timeoutSeconds: SPEC_AUTHOR_TIMEOUT_SECONDS,
  };

  const agentCwd = root ?? cwd();
  let assistantText = "";
  let session: AgentSession | undefined;
  try {
    session = await agent.spawn(agentCwd, agentId, spawnOpts);
    try {
      const events: AgentEvent[] = [];
      let errored: string | undefined;
      for await (const event of agent.prompt(session, prompt, spawnOpts)) {
        events.push(event);
        if (event.type === "error") {
          errored = event.message;
          break;
        }
      }
      if (errored !== undefined) {
        throw new Error(errored);
      }
      assistantText = collectAgentText(events);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, slug }, "Spec authoring prompt stream failed");
      throw new Error(`spec author agent failed: ${msg}`);
    }
  } finally {
    if (session) {
      try {
        await agent.close(session);
      } catch (err) {
        logger.warn({ err, slug }, "Failed to close spec authoring session");
      }
    }
  }

  const assistantMessage = appendSpecMessage(
    slug,
    "assistant" satisfies SpecMessageRole,
    assistantText,
    root,
  );
  return { userMessage, assistantMessage };
}
