import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDoctor, runInit } from "./init.js";
import type { CommandResult, CommandRunner } from "./preflight.js";

type Script = (bin: string, args: string[]) => CommandResult | "notfound";

function fakeRunner(script: Script): CommandRunner {
  return async (bin, args) => {
    const out = script(bin, args);
    if (out === "notfound") return { code: null, stdout: "", stderr: "", notFound: true };
    return { ...out, notFound: false };
  };
}

function ok(stdout = ""): CommandResult {
  return { code: 0, stdout, stderr: "", notFound: false };
}

function fullPassRunner(): CommandRunner {
  return fakeRunner((bin, args) => {
    if (bin === "node") return ok("v20.10.0\n");
    if (bin === "git") return ok("git version 2.40.0\n");
    if (bin === "pnpm") return ok("9.0.0\n");
    if (bin === "which" && args[0] === "acpx") return ok("/usr/local/bin/acpx\n");
    if (bin === "acpx" && args[0] === "--version") return ok("0.12.1\n");
    if (bin === "acpx" && args[1] === "--version") return ok("1.0.0\n");
    if (bin === "acpx" && args[1] === "exec") return ok("hi\n");
    return "notfound";
  });
}

const originalEnv = process.env.MARSHAL_GLOBAL_CONFIG;

afterEach(() => {
  if (originalEnv === undefined) delete process.env.MARSHAL_GLOBAL_CONFIG;
  else process.env.MARSHAL_GLOBAL_CONFIG = originalEnv;
});

describe("runInit", () => {
  let repoRoot: string;
  let configPath: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "marshal-init-"));
    const dir = mkdtempSync(join(tmpdir(), "marshal-init-cfg-"));
    configPath = join(dir, "config.json");
    process.env.MARSHAL_GLOBAL_CONFIG = configPath;
  });

  it("takes the fast path when the machine is already configured", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        acpx: { bin: "acpx", version: ">=0.12.0 <0.13.0" },
        agents: { builder: "opencode", validator: "pi" },
      }),
    );
    const runCmd = fakeRunner(() => "notfound");

    const result = await runInit({
      repoRoot,
      configPath,
      runCmd,
      env: {},
      nonInteractive: false,
    });

    expect(result.ok).toBe(true);
    expect(result.skippedMachine).toBe(true);
    expect(existsSync(join(repoRoot, ".marshal", "state.db"))).toBe(true);
  });

  it("runs all phases without writing config in non-interactive mode", async () => {
    const result = await runInit({
      repoRoot,
      configPath,
      runCmd: fullPassRunner(),
      env: { OPENAI_API_KEY: "sk-x", ANTHROPIC_API_KEY: "sk-y" },
      nonInteractive: true,
    });

    expect(result.ok).toBe(true);
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(join(repoRoot, ".marshal", "state.db"))).toBe(true);
  });

  it("still initializes repo state in non-interactive mode even when acpx is missing", async () => {
    const runCmd = fakeRunner((bin) => {
      if (bin === "node") return ok("v20.10.0\n");
      if (bin === "git") return ok("git version 2.40.0\n");
      if (bin === "pnpm") return ok("9.0.0\n");
      return "notfound";
    });

    const result = await runInit({
      repoRoot,
      configPath,
      runCmd,
      env: {},
      nonInteractive: true,
    });

    expect(result.ok).toBe(false);
    expect(existsSync(join(repoRoot, ".marshal", "state.db"))).toBe(true);
  });

  it("writes config on confirm in interactive mode and preserves existing keys", async () => {
    writeFileSync(configPath, JSON.stringify({ agents: { builder: "claude-code" } }));
    const prompts: string[] = [];
    const prompt = async (q: string): Promise<boolean> => {
      prompts.push(q);
      return /Write this config/.test(q);
    };

    const result = await runInit({
      repoRoot,
      configPath,
      runCmd: fullPassRunner(),
      env: { OPENAI_API_KEY: "sk-x", ANTHROPIC_API_KEY: "sk-y" },
      nonInteractive: false,
      prompt,
    });

    expect(result.ok).toBe(true);
    expect(existsSync(configPath)).toBe(true);
    const written = JSON.parse(
      await import("node:fs").then((m) => m.readFileSync(configPath, "utf8")),
    );
    expect(written.agents.builder).toBe("claude-code");
    expect(written.agents.validator).toBe("pi");
    expect(written.acpx.version).toBe(">=0.12.0 <0.13.0");
  });

  it("does not write config when the user declines", async () => {
    const prompt = async (): Promise<boolean> => false;

    await runInit({
      repoRoot,
      configPath,
      runCmd: fullPassRunner(),
      env: {},
      nonInteractive: false,
      prompt,
    });

    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(join(repoRoot, ".marshal", "state.db"))).toBe(true);
  });

  it("offers to install acpx when missing in interactive mode", async () => {
    const runCmd = fakeRunner((bin) => {
      if (bin === "node") return ok("v20.10.0\n");
      if (bin === "git") return ok("git version 2.40.0\n");
      if (bin === "pnpm") return ok("9.0.0\n");
      return "notfound";
    });
    const prompts: string[] = [];
    const prompt = async (q: string): Promise<boolean> => {
      prompts.push(q);
      return false;
    };

    await runInit({
      repoRoot,
      configPath,
      runCmd,
      env: {},
      nonInteractive: false,
      prompt,
    });

    expect(prompts.some((q) => /Install with `npm i -g acpx@/.test(q))).toBe(true);
  });
});

describe("runDoctor", () => {
  let repoRoot: string;
  let configPath: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "marshal-doc-"));
    const dir = mkdtempSync(join(tmpdir(), "marshal-doc-cfg-"));
    configPath = join(dir, "config.json");
    process.env.MARSHAL_GLOBAL_CONFIG = configPath;
  });

  it("reports ok when all checks pass and config exists", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        acpx: { bin: "acpx", version: ">=0.12.0 <0.13.0" },
        agents: { builder: "opencode", validator: "pi" },
      }),
    );
    const result = await runDoctor({
      repoRoot,
      configPath,
      runCmd: fullPassRunner(),
      env: { OPENAI_API_KEY: "sk-x", ANTHROPIC_API_KEY: "sk-y" },
    });
    expect(result.ok).toBe(true);
    // doctor never initializes repo state.
    expect(existsSync(join(repoRoot, ".marshal"))).toBe(false);
  });

  it("reports not ok when acpx is missing and config is absent", async () => {
    const runCmd = fakeRunner((bin) => {
      if (bin === "node") return ok("v20.10.0\n");
      if (bin === "git") return ok("git version 2.40.0\n");
      if (bin === "pnpm") return ok("9.0.0\n");
      return "notfound";
    });
    const result = await runDoctor({
      repoRoot,
      configPath,
      runCmd,
      env: {},
    });
    expect(result.ok).toBe(false);
    expect(existsSync(join(repoRoot, ".marshal"))).toBe(false);
  });
});
