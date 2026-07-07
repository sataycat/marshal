import type { Command } from "commander";
import { isTaskStatus, type TaskStatus } from "./state-machine.js";
import {
  DuplicateSlugError,
  TaskNotFoundError,
  createTask,
  getTask,
  listTasks,
  transitionTask,
} from "./store.js";

function fail(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
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
    .action((options: { title: string; slug: string; spec?: string }) => {
      try {
        const t = createTask({
          slug: options.slug,
          title: options.title,
          specMarkdown: options.spec,
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
        console.log(`slug:   ${t.slug}`);
        console.log(`title:  ${t.title}`);
        console.log(`status: ${t.status}`);
        console.log(`id:     ${t.id}`);
        console.log(`created: ${t.created_at}`);
        console.log(`updated: ${t.updated_at}`);
        if (t.spec_markdown) {
          console.log("--- spec ---");
          console.log(t.spec_markdown);
        }
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
}
