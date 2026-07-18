#!/usr/bin/env node
import { Command } from "commander";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startHttpServer } from "./daemon/http.js";
import { startDaemon } from "./daemon/loop.js";
import { runDoctor, runInit } from "./setup/init.js";
import { registerTaskCommands } from "./tasks/commands.js";
import { WorktreeManager } from "./worktree/manager.js";
import { GLOBAL_DIR } from "./daemon/config.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const pkgPath = resolve(__dirname, "../package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

const program = new Command()
  .name("marshal")
  .description("Factory harness orchestrator")
  .version(pkg.version);

program
  .command("init", { hidden: true })
  .description("[recovery] retired browser onboarding; use the web application")
  .action(async () => {
    const result = await runInit();
    if (!result.ok) {
      process.exitCode = 1;
    }
  });

program
  .command("doctor", { hidden: true })
  .description("[recovery] retired diagnostics; use the browser Diagnostics page")
  .action(async () => {
    const result = await runDoctor();
    if (!result.ok) {
      process.exitCode = 1;
    }
  });

const task = program.command("task").description("[development/recovery] task management; use the browser Board");
registerTaskCommands(task);

const worktree = program.command("worktree").description("[development/recovery] worktree management; use the browser workflow");

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

program
  .command("start")
  .description("Start the daemon and serve the browser application")
  .option("--interval <ms>", "Poll interval in milliseconds", "5000")
  .option("--port <number>", "HTTP API port (default: 7433 or config daemon.port)")
  .option("--host <addr>", "HTTP API bind address (default: 127.0.0.1)")
  .option("--lan", "Bind to all interfaces (0.0.0.0); requires a UI password")
  .option("--password <password>", "UI password required for non-loopback access")
  .action(async (options: { interval: string; port?: string; host?: string; lan?: boolean; password?: string }) => {
    if (options.lan && options.host) {
      throw new Error("The --lan and --host options cannot be combined.");
    }
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
      const port = options.port !== undefined ? Number(options.port) : undefined;
      const host = options.lan ? "0.0.0.0" : options.host;
      const http = await startHttpServer({
        host,
        port,
        uiPassword: options.password,
        version: pkg.version,
      });
      try {
        await startDaemon({
          intervalMs: Number(options.interval),
          signal: controller.signal,
          bus: http.bus,
        });
      } finally {
        await http.close();
      }
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  });

program.command("stop").description("Stop the Marshal daemon").action(() => {
  const pidPath = resolve(GLOBAL_DIR, "daemon.pid");
  if (!existsSync(pidPath)) { console.log("Marshal daemon is not running."); return; }
  const pid = Number(readFileSync(pidPath, "utf8"));
  try { process.kill(pid, "SIGTERM"); console.log(`Stopped Marshal daemon (pid ${pid}).`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") { unlinkSync(pidPath); console.log("Marshal daemon was not running."); return; } throw error; }
});

program.command("status").description("Inspect Marshal daemon status").action(async () => {
  const portPath = resolve(GLOBAL_DIR, "daemon.port");
  if (!existsSync(portPath)) { console.log("Marshal daemon: stopped"); return; }
  const port = Number(readFileSync(portPath, "utf8"));
  try { const response = await fetch(`http://127.0.0.1:${port}/api/health`); const body = await response.json() as { version?: string }; console.log(`Marshal daemon: running (port ${port}${body.version ? `, version ${body.version}` : ""})`); }
  catch { console.log(`Marshal daemon: unavailable (stale port ${port})`); process.exitCode = 1; }
});

try {
  await program.parseAsync(process.argv);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
}
