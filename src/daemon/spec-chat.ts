import type { Agent, AgentEvent, AgentId } from "../agent/types.js";
import { logger } from "../logger.js";
import { getTask } from "../tasks/store.js";
import {
  appendSpecMessage,
  clearSpecMessagePromptFailure,
  getSpecMessage,
  markSpecMessageAuthenticationRequired,
  listSpecMessages,
  type SpecMessage,
  type SpecMessageRole,
} from "../tasks/spec-store.js";
import { AcpSessionSupervisor } from "../acp/supervisor.js";
import { createSpecAuthorSession, updateSpecAuthorSession, appendSpecAuthorOperation } from "../tasks/author-store.js";
import { getWorkflowProfile } from "../workflows/store.js";
import { historicalProvenance } from "../agents/provenance.js";
import { StructuredAcpFailureError, structuredAcpError } from "../acp/errors.js";

const SPEC_AUTHOR_TIMEOUT_SECONDS = 600;
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
      throw event.failure ? new StructuredAcpFailureError(event.failure) : new Error(event.message);
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
  machineDir?: string;
  repositoryId?: string;
}

export interface SpecAuthorTurnResult {
  userMessage: SpecMessage;
  assistantMessage: SpecMessage | null;
}

export async function runSpecAuthorTurn(
  slug: string,
  userContent: string,
  options: RunSpecAuthorTurnOptions = {},
  recoveryMessageId?: number,
): Promise<SpecAuthorTurnResult> {
  const root = options.root;
  const task = options.repositoryId ? getTask(options.repositoryId, slug, options.machineDir) : getTask(slug, root);
  if (task.status !== "backlog") {
    throw new SpecChatClosedError(slug, task.status);
  }

  const existingMessage = recoveryMessageId === undefined ? undefined : options.repositoryId ? getSpecMessage(options.repositoryId, recoveryMessageId, options.machineDir) : getSpecMessage(recoveryMessageId, root);
  if (recoveryMessageId !== undefined && (!existingMessage || existingMessage.task_id !== task.id || existingMessage.role !== "user" || existingMessage.prompt_status !== "authentication_required" || existingMessage.content !== userContent)) throw new Error("Only the preserved authentication-required spec message can be resubmitted");
  const userMessage = existingMessage ?? (options.repositoryId ? appendSpecMessage(options.repositoryId, slug, "user", userContent, options.machineDir) : appendSpecMessage(slug, "user", userContent, root));

  const repositoryId = task.repository_id ?? undefined;
  const profile = task.workflow_profile_id && repositoryId
    ? getWorkflowProfile(repositoryId, task.workflow_profile_id, options.machineDir)
    : undefined;
  const assignment = profile?.assignments.find((item) => item.role === "specAuthor");
  if (!options.agent && (!repositoryId || !profile || !assignment)) {
    throw new Error("Task has no valid workflow profile spec-author assignment");
  }
  const agentId: AgentId = options.agentId ?? assignment?.agent_id ?? "test-spec-author";

  const specMessages = options.repositoryId ? listSpecMessages(options.repositoryId, slug, options.machineDir) : listSpecMessages(slug, root);
  const prompt = renderSpecAuthoringPrompt(task, specMessages, {
    chatBudgetChars: options.chatBudgetChars,
  });

  let assistantText = "";
  const authorRecord = profile && assignment && repositoryId
      ? createSpecAuthorSession({ taskId: task.id, repositoryId, workflowProfileId: profile.id, assignmentId: assignment.id, agentId: assignment.agent_id, agentVersion: assignment.agent_version, agentProvenance: assignment.agent_provenance ?? historicalProvenance(assignment.agent_id, assignment.agent_version), assignmentConfig: { model: assignment.model, mode: assignment.mode, permission_policy: profile.permission_policy }, messageId: userMessage.id }, root)
    : undefined;
  try {
    if (!authorRecord) {
      // Injected agents remain a test seam; production always uses the profile path.
      const events: AgentEvent[] = [];
      const session = await options.agent!.spawn(root ?? process.cwd(), agentId, { sessionName: `marshal-${slug}-spec`, permissionMode: "approve-reads", timeoutSeconds: SPEC_AUTHOR_TIMEOUT_SECONDS });
      for await (const event of options.agent!.prompt(session, prompt, { permissionMode: "approve-reads" })) { events.push(event); if (event.type === "error") throw event.failure ? new StructuredAcpFailureError(event.failure) : new Error(event.message); }
      assistantText = collectAgentText(events);
      await options.agent!.close(session);
    } else {
      appendSpecAuthorOperation(options.repositoryId!, authorRecord.id, "author", "running", null, options.machineDir, null);
      const supervisor = new AcpSessionSupervisor({ repositoryId: repositoryId!, root, machineDir: options.machineDir, agent: options.agent, permissionPolicy: profile!.permission_policy });
      const started = await supervisor.start("spec-author", authorRecord.id, root ?? process.cwd(), assignment!.agent_id, assignment!.agent_version, { agentProvenance: authorRecord.agent_provenance });
      updateSpecAuthorSession(options.repositoryId!, authorRecord.id, { supervisorSessionId: started.record.id, acpSessionId: started.record.acp_session_id, capabilities: started.record.capabilities }, options.machineDir);
      const events: AgentEvent[] = [];
      await supervisor.prompt(started.record.id, prompt, undefined, (event) => events.push(event), { messageId: userMessage.id, ...(recoveryMessageId === undefined ? {} : { resubmissionOf: String(recoveryMessageId) }) });
      assistantText = collectAgentText(events);
      await supervisor.close(started.record.id);
      appendSpecAuthorOperation(options.repositoryId!, authorRecord.id, "author", "succeeded", null, options.machineDir, null);
      updateSpecAuthorSession(options.repositoryId!, authorRecord.id, { status: "completed" }, options.machineDir);
    }
  } catch (err) {
    const failure = structuredAcpError(err);
    if (failure.kind === "authentication_required") options.repositoryId ? markSpecMessageAuthenticationRequired(options.repositoryId, userMessage.id, failure, options.machineDir) : markSpecMessageAuthenticationRequired(userMessage.id, failure, root);
    if (authorRecord) { appendSpecAuthorOperation(options.repositoryId!, authorRecord.id, "author", failure.kind === "authentication_required" ? "authentication_required" : "failed", failure.message, options.machineDir, failure); updateSpecAuthorSession(options.repositoryId!, authorRecord.id, { status: failure.kind === "authentication_required" ? "authentication_required" : "failed", failure }, options.machineDir); }
    logger.error({ err, slug }, "Spec authoring prompt stream failed");
    throw new StructuredAcpFailureError(failure);
  }

  const assistantMessage = appendSpecMessage(
    slug,
    "assistant" satisfies SpecMessageRole,
    assistantText,
    root,
  );
  const finalUserMessage = recoveryMessageId !== undefined ? options.repositoryId ? clearSpecMessagePromptFailure(options.repositoryId, userMessage.id, options.machineDir) : clearSpecMessagePromptFailure(userMessage.id, root) : userMessage;
  return { userMessage: finalUserMessage, assistantMessage };
}

export function resubmitSpecAuthorTurn(slug: string, messageId: number, options: RunSpecAuthorTurnOptions = {}): Promise<SpecAuthorTurnResult> { const message = options.repositoryId ? getSpecMessage(options.repositoryId, messageId, options.machineDir) : getSpecMessage(messageId, options.root); if (!message) throw new Error("Spec message not found"); return runSpecAuthorTurn(slug, message.content, options, messageId); }
