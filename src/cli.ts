#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getRepoStateDir, initGlobalConfig, initRepoState } from "./daemon/config.js";
import { formatRunOnceResult, startDaemon } from "./daemon/loop.js";
import { runOnce } from "./daemon/orchestrator.js";
import { openDb } from "./db/index.js";
import { registerTaskCommands } from "./tasks/commands.js";
import { WorktreeManager } from "./worktree/manager.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const pkgPath = resolve(__dirname, "../package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

const program = new Command()
  .name("marshal")
  .description("Factory harness orchestrator")
  .version(pkg.version);

program
  .command("init")
  .description("Initialize marshal state in the current repo")
  .action(() => {
    initGlobalConfig();
    initRepoState();
    openDb();
    console.log("Marshal initialized at %s", getRepoStateDir());
  });

const task = program.command("task").description("Task management");
registerTaskCommands(task);

const worktree = program.command("worktree").description("Worktree management");

worktree
  .command("create")
  .description("Create a worktree for a task")
  .requiredOption("--task <slug>", "Task slug")
  .action(async (options: { task: string }) => {
    const manager = new WorktreeManager(process.cwd());
    const info = manager.create(options.task);
    console.log(info.path);
  });

worktree
  .command("destroy")
  .description("Destroy a task worktree and its branch")
  .requiredOption("--task <slug>", "Task slug")
  .action((options: { task: string }) => {
    const manager = new WorktreeManager(process.cwd());
    manager.destroy(options.task);
  });

const daemon = program.command("daemon").description("Daemon control");

daemon
  .command("run-once")
  .description("Run a single orchestrator cycle (build or validate one task)")
  .action(async () => {
    const result = await runOnce({ root: process.cwd() });
    console.log(formatRunOnceResult(result));
  });

daemon
  .command("start")
  .description("Run the orchestrator daemon, polling for ready tasks")
  .option("--interval <ms>", "Poll interval in milliseconds", "5000")
  .action(async (options: { interval: string }) => {
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
      await startDaemon({
        root: process.cwd(),
        intervalMs: Number(options.interval),
        signal: controller.signal,
      });
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  });

await program.parseAsync(process.argv);
