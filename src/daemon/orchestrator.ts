import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { cwd } from "node:process";
import { AcpxAgentAdapter } from "../agent/acpx-adapter.js";
import type { Agent, AgentSession, SpawnOptions } from "../agent/types.js";
import { logger } from "../logger.js";
import { openDb } from "../db/index.js";
import { getTask, transitionTask, type Task } from "../tasks/store.js";
import { specRelPathFor } from "../tasks/freeze.js";
import { WorktreeManager } from "../worktree/manager.js";
import { RunLog } from "./run-log.js";

export interface RunOnceResult {
  slug: string;
  runId: number;
  commitSha: string;
  status: "built" | "error" | "skipped";
  error?: string;
}

const BUILDER_AGENT_ID = "opencode" as const;
const BUILDER_TIMEOUT_SECONDS = 1800;
const BUILDER_PERMISSION_MODE = "approve-all" as const;

interface ReadyTaskRow {
  slug: string;
}

function gitInWorktree(worktreePath: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: worktreePath,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function renderBuilderPrompt(task: Task): string {
  return [
    `You are working on task "${task.title}" (slug: ${task.slug}).`,
    "",
    "## Spec",
    "",
    task.spec_markdown.trimEnd(),
    "",
    "## Instructions",
    "",
    "Follow repo conventions (see AGENTS.md if present). Write tests for new code. Run type-checks and tests before finishing.",
    "",
    "Do not commit — your changes will be committed automatically when you finish.",
    "",
  ].join("\n");
}

export interface BuildTaskOptions {
  root?: string;
  agent?: Agent;
  manager?: WorktreeManager;
}

export async function buildTask(
  slug: string,
  options: BuildTaskOptions = {},
): Promise<RunOnceResult> {
  const root = options.root;
  const task = getTask(slug, root);

  const manager = options.manager ?? new WorktreeManager(root ?? cwd());
  const agent = options.agent ?? new AcpxAgentAdapter();
  const runLog = new RunLog(root);

  const worktree = manager.create(slug);
  const prompt = renderBuilderPrompt(task);
  const runId = runLog.startRun(task.id, "builder", BUILDER_AGENT_ID, prompt);

  const spawnOpts: SpawnOptions = {
    sessionName: `marshal-${slug}-builder`,
    permissionMode: BUILDER_PERMISSION_MODE,
    timeoutSeconds: BUILDER_TIMEOUT_SECONDS,
  };

  let session: AgentSession | undefined;
  try {
    try {
      session = await agent.spawn(worktree.path, BUILDER_AGENT_ID, spawnOpts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, slug, runId }, "Builder spawn failed");
      runLog.finishRun(runId, "error", { error: `spawn failed: ${msg}` });
      return { slug, runId, commitSha: "", status: "error", error: `spawn failed: ${msg}` };
    }

    let errorMessage: string | undefined;
    let seq = 0;

    try {
      for await (const event of agent.prompt(session, prompt, spawnOpts)) {
        runLog.insertEvent(runId, seq, event);
        seq += 1;
        if (event.type === "error") {
          errorMessage = event.message;
          break;
        }
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      logger.error({ err, slug, runId }, "Builder prompt stream failed");
    }

    if (errorMessage !== undefined) {
      runLog.finishRun(runId, "error", { error: errorMessage });
      return { slug, runId, commitSha: "", status: "error", error: errorMessage };
    }

    let commitSha: string;
    try {
      gitInWorktree(worktree.path, ["add", "-A"]);
      gitInWorktree(worktree.path, ["commit", "--allow-empty", "-m", `build: ${slug}`]);
      commitSha = gitInWorktree(worktree.path, ["rev-parse", "HEAD"]).trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, slug, runId }, "Builder commit failed");
      runLog.finishRun(runId, "error", { error: `commit failed: ${msg}` });
      return { slug, runId, commitSha: "", status: "error", error: `commit failed: ${msg}` };
    }

    runLog.finishRun(runId, "done", { commitSha });
    logger.info({ slug, runId, commitSha }, "Builder run complete");
    return { slug, runId, commitSha, status: "built" };
  } finally {
    if (session) {
      try {
        await agent.close(session);
      } catch (err) {
        logger.warn({ err, slug }, "Failed to close builder session");
      }
    }
  }
}

export interface RunOnceOptions {
  root?: string;
  agent?: Agent;
  manager?: WorktreeManager;
}

export async function runOnce(
  options: RunOnceOptions = {},
): Promise<RunOnceResult | null> {
  const root = options.root;

  const db = openDb(root);
  const row = db
    .prepare("SELECT slug FROM tasks WHERE status = 'ready' ORDER BY created_at ASC, id ASC LIMIT 1")
    .get() as ReadyTaskRow | undefined;
  db.close();
  if (!row) {
    return null;
  }

  const slug = row.slug;
  const task = getTask(slug, root);

  const manager = options.manager ?? new WorktreeManager(root ?? cwd());

  let worktree;
  try {
    worktree = manager.create(slug);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ slug, err }, "Pre-flight worktree lookup failed");
    return {
      slug,
      runId: 0,
      commitSha: "",
      status: "skipped",
      error: `worktree missing: ${msg}`,
    };
  }

  const specRel = specRelPathFor(slug, task.id);
  const specAbs = resolve(worktree.path, specRel);
  if (!existsSync(specAbs)) {
    logger.warn({ slug, specRel }, "Pre-flight frozen spec file missing");
    return {
      slug,
      runId: 0,
      commitSha: "",
      status: "skipped",
      error: `frozen spec missing: ${specRel}`,
    };
  }

  transitionTask(slug, "building", root);

  const result = await buildTask(slug, { root, agent: options.agent, manager });

  if (result.status === "built") {
    transitionTask(slug, "validating", root);
  }

  return result;
}
