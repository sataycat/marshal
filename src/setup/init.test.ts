import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_COMMAND_DEFAULTS } from "../worktree/config.js";
import { runDoctor, runInit } from "./init.js";
import type { CommandResult, CommandRunner } from "./preflight.js";

function systemRunner(): CommandRunner {
  return async (bin) => {
    const stdout =
      bin === "node" ? "v20.10.0\n" : bin === "git" ? "git version 2.40.0\n" : "9.0.0\n";
    return { code: 0, stdout, stderr: "", notFound: false };
  };
}

const originalConfig = process.env.MARSHAL_GLOBAL_CONFIG;

afterEach(() => {
  if (originalConfig === undefined) delete process.env.MARSHAL_GLOBAL_CONFIG;
  else process.env.MARSHAL_GLOBAL_CONFIG = originalConfig;
});

describe("runInit", () => {
  let repoRoot: string;
  let configPath: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "marshal-init-"));
    configPath = join(mkdtempSync(join(tmpdir(), "marshal-config-")), "config.json");
    process.env.MARSHAL_GLOBAL_CONFIG = configPath;
  });

  it("writes direct ACP defaults without checking for ACPX", async () => {
    const calls: string[] = [];
    const runCmd: CommandRunner = async (bin, args) => {
      calls.push(`${bin} ${args.join(" ")}`);
      return systemRunner()(bin, args);
    };
    const result = await runInit({ repoRoot, configPath, runCmd });
    const written = JSON.parse(readFileSync(configPath, "utf8"));

    expect(result.ok).toBe(true);
    expect(written.agents).toEqual(AGENT_COMMAND_DEFAULTS);
    expect(written.acpx).toBeUndefined();
    expect(calls.some((call) => call.includes("acpx"))).toBe(false);
    expect(existsSync(join(repoRoot, ".marshal", "state.db"))).toBe(true);
  });

  it("migrates legacy string roles to direct defaults", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        acpx: { bin: "acpx", version: ">=0.12.0 <0.13.0" },
        agents: { builder: "opencode", validator: "pi", specAuthor: "opencode" },
      }),
    );
    await runInit({ repoRoot, configPath, runCmd: systemRunner() });
    const written = JSON.parse(readFileSync(configPath, "utf8"));

    expect(written.agents).toEqual(AGENT_COMMAND_DEFAULTS);
    expect(written.acpx).toBeUndefined();
  });

  it("takes the fast path for complete direct configuration", async () => {
    writeFileSync(configPath, JSON.stringify({ agents: AGENT_COMMAND_DEFAULTS }));
    const result = await runInit({ repoRoot, configPath, runCmd: systemRunner() });
    expect(result).toEqual({ ok: true, skippedMachine: true });
  });

  it("does not write config when a required system prerequisite fails", async () => {
    const missing: CommandResult = { code: null, stdout: "", stderr: "", notFound: true };
    const result = await runInit({ repoRoot, configPath, runCmd: async () => missing });
    expect(result.ok).toBe(false);
    expect(existsSync(configPath)).toBe(false);
  });
});

describe("runDoctor", () => {
  it("rejects legacy string roles with a migration message", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "marshal-doctor-"));
    const configPath = join(mkdtempSync(join(tmpdir(), "marshal-config-")), "config.json");
    writeFileSync(configPath, JSON.stringify({ agents: { builder: "opencode", validator: "pi" } }));
    const result = await runDoctor({ repoRoot, configPath, runCmd: systemRunner() });
    expect(result.ok).toBe(false);
    expect(existsSync(join(repoRoot, ".marshal"))).toBe(false);
  });
});
