import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { registerRepository, selectRepository } from "../src/repositories/store.js";

const cliPath = resolve(process.cwd(), "bin/marshal");

export function runCli(args: string[], cwd?: string): { stdout: string; stderr: string } {
  const result = execFileSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { stdout: result.toString(), stderr: "" };
}

export function spawnCli(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: "utf8", env });
}

export function useCliTestEnvironment(): { selectTestRepository(root: string): void } {
  let originalHome: string | undefined;
  let home: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "marshal-home-"));
    process.env.HOME = home;
    const globalConfigPath = join(process.env.MARSHAL_HOME!, "config.json");
    writeFileSync(
      globalConfigPath,
      JSON.stringify({
        agents: {
          builder: { id: "opencode", command: "opencode", args: ["acp"] },
          validator: { id: "pi", command: "pi-acp", args: [] },
        },
      }),
    );
    process.env.MARSHAL_GLOBAL_CONFIG = globalConfigPath;
  });

  afterEach(() => {
    delete process.env.MARSHAL_GLOBAL_CONFIG;
    rmSync(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  return {
    selectTestRepository(root: string): void {
      const repository = registerRepository(root);
      selectRepository(repository.id);
    },
  };
}
