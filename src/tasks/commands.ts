import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { isTaskStatus, type TaskStatus } from "./state-machine.js";
import {
  DuplicateSlugError,
  TaskNotFoundError,
  createTask,
  getTask,
  listTasks,
  transitionTask,
  type Task,
} from "./store.js";
import { freezeTask, FreezeError } from "./freeze.js";
import type { RunRecord } from "../daemon/run-log.js";
import { RunLog } from "../daemon/run-log.js";

function fail(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
}

function resolveSpec(spec?: string, specFile?: string): string | undefined {
  if (spec !== undefined && specFile !== undefined) {
    throw new Error("Use either --spec or --spec-file, not both");
  }
  if (specFile !== undefined) {
    return readFileSync(specFile, "utf8");
  }
  return spec;
}

export function renderTaskShow(task: Task, lastRun?: RunRecord): string {
  const lines: string[] = [
    `slug:   ${task.slug}`,
    `title:  ${task.title}`,
    `status: ${task.status}`,
    `id:     ${task.id}`,
    `retries: ${task.retry_count}`,
    `created: ${task.created_at}`,
    `updated: ${task.updated_at}`,
  ];
  if (task.last_failure) {
    lines.push(`last failure: ${task.last_failure}`);
  }
  if (lastRun && (task.status === "building" || task.status === "validating")) {
    lines.push(`last run: #${lastRun.id} ${lastRun.role} ${lastRun.agentId} ${lastRun.status}`);
    if (lastRun.error) {
      lines.push(`run error: ${lastRun.error}`);
    }
  }
  if (task.spec_markdown) {
    lines.push("--- spec ---");
    lines.push(task.spec_markdown);
  }
  return lines.join("\n");
}

export function registerTaskCommands(task: Command): void {
  task
    .command("list")
    .description("List all tasks")
    .action(() => {
      const tasks = listTasks();
      if (tasks.length === 0) {
        console.log("No tasks.");
        return;
      }
      for (const t of tasks) {
        console.log(`${t.slug}\t${t.status}\t${t.title}`);
      }
    });

  task
    .command("create")
    .description("Create a new task in the backlog")
    .requiredOption("--title <title>", "Task title")
    .requiredOption("--slug <slug>", "Task slug")
    .option("--spec <markdown>", "Spec markdown")
    .option("--spec-file <path>", "Path to a spec markdown file")
    .action((options: { title: string; slug: string; spec?: string; specFile?: string }) => {
      try {
        const specMarkdown = resolveSpec(options.spec, options.specFile);
        const t = createTask({
          slug: options.slug,
          title: options.title,
          specMarkdown,
        });
        console.log(`Created ${t.slug} (${t.status})`);
      } catch (err) {
        if (err instanceof DuplicateSlugError) fail(err);
        throw err;
      }
    });

  task
    .command("show")
    .description("Show a single task")
    .argument("<slug>", "Task slug")
    .action((slug: string) => {
      try {
        const t = getTask(slug);
        let lastRun: RunRecord | undefined;
        if (t.status === "building" || t.status === "validating") {
          lastRun = new RunLog().getLastRunForTask(t.id);
        }
        console.log(renderTaskShow(t, lastRun));
      } catch (err) {
        if (err instanceof TaskNotFoundError) fail(err);
        throw err;
      }
    });

  task
    .command("transition")
    .description("Transition a task to a new state")
    .argument("<slug>", "Task slug")
    .argument("<state>", "New state")
    .action((slug: string, state: string) => {
      if (!isTaskStatus(state)) {
        console.error(`Unknown state: ${state}`);
        process.exit(1);
      }
      try {
        const t = transitionTask(slug, state as TaskStatus);
        console.log(`${t.slug} -> ${t.status}`);
      } catch (err) {
        if (err instanceof TaskNotFoundError || err instanceof Error) fail(err);
        throw err;
      }
    });

  task
    .command("ready")
    .description("Transition a backlog task to ready and freeze its spec to the task branch")
    .argument("<slug>", "Task slug")
    .action((slug: string) => {
      try {
        transitionTask(slug, "ready");
      } catch (err) {
        if (err instanceof TaskNotFoundError) fail(err);
        throw err;
      }
      try {
        const result = freezeTask(slug);
        console.log(`${slug} -> ready`);
        console.log(`frozen: ${result.specRelPath} @ ${result.commitSha.slice(0, 12)}`);
        console.log(`branch: ${result.branch}`);
        console.log(`worktree: ${result.worktreePath}`);
      } catch (err) {
        if (err instanceof FreezeError) {
          console.error(
            `Task ${slug} is in 'ready' but freeze failed: ${err.message}\n` +
              `Run \`marshal task freeze ${slug}\` to retry.`,
          );
          process.exit(1);
        }
        throw err;
      }
    });

  task
    .command("freeze")
    .description("Freeze (or re-freeze) a ready task's spec to its task branch")
    .argument("<slug>", "Task slug")
    .action((slug: string) => {
      try {
        const result = freezeTask(slug);
        console.log(`frozen: ${result.specRelPath} @ ${result.commitSha.slice(0, 12)}`);
        console.log(`branch: ${result.branch}`);
        console.log(`worktree: ${result.worktreePath}`);
      } catch (err) {
        if (err instanceof FreezeError) fail(err);
        throw err;
      }
    });
}
