#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getRepoStateDir, initGlobalConfig, initRepoState } from "./daemon/config.js";
import { openDb } from "./db/index.js";
import { logger } from "./logger.js";
import { listTasks } from "./tasks/store.js";

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
    logger.info("Marshal initialized at %s", getRepoStateDir());
  });

const task = program.command("task").description("Task management");

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

await program.parseAsync(process.argv);
