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

  // ADR-022 Decision 3: --non-interactive alone writes nothing.
  it("non-interactive mode writes nothing without --yes", async () => {
    const result = await runInit({
      repoRoot,
      configPath,
      runCmd: fullPassRunner(),
      env: {},
      nonInteractive: true,
    });

    expect(result.ok).toBe(true);
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(join(repoRoot, ".marshal", "state.db"))).toBe(false);
  });

  it("non-interactive --yes reproduces the old run-everything behavior", async () => {
    const result = await runInit({
      repoRoot,
      configPath,
      runCmd: fullPassRunner(),
      env: {},
      nonInteractive: true,
      yes: true,
    });

    expect(result.ok).toBe(true);
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(join(repoRoot, ".marshal", "state.db"))).toBe(true);
  });

  it("non-interactive mode honors MARSHAL_INIT_YES=1 as consent", async () => {
    const result = await runInit({
      repoRoot,
      configPath,
      runCmd: fullPassRunner(),
      env: { MARSHAL_INIT_YES: "1" },
      nonInteractive: true,
    });

    expect(result.ok).toBe(true);
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(join(repoRoot, ".marshal", "state.db"))).toBe(true);
  });

  it("reports not-ok in non-interactive mode when acpx is missing, writes nothing without --yes", async () => {
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
    expect(existsSync(join(repoRoot, ".marshal", "state.db"))).toBe(false);
    expect(existsSync(configPath)).toBe(false);
  });

  it("writes config on confirm in interactive mode and preserves existing keys", async () => {
    writeFileSync(configPath, JSON.stringify({ agents: { builder: "claude-code" } }));
    const prompts: string[] = [];
    const prompt = async (q: string): Promise<boolean> => {
      prompts.push(q);
      return /Initialize Marshal in this repo/.test(q);
    };

    const result = await runInit({
      repoRoot,
      configPath,
      runCmd: fullPassRunner(),
      env: {},
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
    // ADR-022 Decision 1: single merged prompt names both write targets.
    expect(prompts.some((q) => /~\/.marshal\/config\.json/.test(q))).toBe(true);
    expect(prompts.some((q) => /\.marshal\/state\.db/.test(q))).toBe(true);
    // Old "Write this config?" copy must be gone.
    expect(prompts.some((q) => /^Write this config\?$/.test(q))).toBe(false);
  });

  // ADR-022 Decision 1: declining the merged prompt writes nothing —
  // neither ~/.marshal/config.json nor .marshal/state.db.
  it("writes nothing — no config, no repo state — when the user declines the merged prompt", async () => {
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
    expect(existsSync(join(repoRoot, ".marshal", "state.db"))).toBe(false);
    expect(existsSync(join(repoRoot, ".marshal"))).toBe(false);
  });

  it("re-running init when the machine is already configured and the repo state exists takes the fast path (no prompt)", async () => {
    // Machine already configured.
    writeFileSync(
      configPath,
      JSON.stringify({
        acpx: { bin: "acpx", version: ">=0.12.0 <0.13.0" },
        agents: { builder: "opencode", validator: "pi" },
      }),
    );
    // Repo state already present.
    const stateDir = join(repoRoot, ".marshal");
    await import("node:fs").then((m) => m.mkdirSync(stateDir, { recursive: true }));
    await import("node:fs").then((m) =>
      m.writeFileSync(join(stateDir, "state.db"), Buffer.from("")),
    );

    const prompts: string[] = [];
    const prompt = async (q: string): Promise<boolean> => {
      prompts.push(q);
      return false;
    };

    const result = await runInit({
      repoRoot,
      configPath,
      runCmd: fullPassRunner(),
      env: {},
      nonInteractive: false,
      prompt,
    });

    expect(result.ok).toBe(true);
    expect(result.skippedMachine).toBe(true);
    expect(prompts.some((q) => /Initialize Marshal/.test(q))).toBe(false);
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

// ADR-022 Decision 2: no provider env var name may appear in the preflight
// output surfaced by `init` or `doctor`. Regressions here are a direct
// violation of the open agent-ID model.
function captureStdout<T>(fn: () => Promise<T>): Promise<{ out: string; ret: T }> {
  return (async () => {
    let out = "";
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as NodeJS.WriteStream).write = ((chunk: unknown) => {
      out += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
      return true;
    }) as typeof process.stdout.write;
    try {
      const ret = await fn();
      return { out, ret };
    } finally {
      process.stdout.write = orig;
    }
  })();
}

describe("ADR-022 Decision 2 — init/doctor output never names provider env vars", () => {
  let repoRoot: string;
  let configPath: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "marshal-init-noenv-"));
    const dir = mkdtempSync(join(tmpdir(), "marshal-init-noenv-cfg-"));
    configPath = join(dir, "config.json");
    process.env.MARSHAL_GLOBAL_CONFIG = configPath;
  });

  it("init interactive output contains no OPENAI_API_KEY / ANTHROPIC_API_KEY", async () => {
    const prompt = async (): Promise<boolean> => false;
    const { out } = await captureStdout(() =>
      runInit({
        repoRoot,
        configPath,
        runCmd: fullPassRunner(),
        env: {},
        nonInteractive: false,
        prompt,
      }),
    );
    expect(out).not.toMatch(/OPENAI_API_KEY/);
    expect(out).not.toMatch(/ANTHROPIC_API_KEY/);
  });

  it("init --non-interactive --yes output contains no OPENAI_API_KEY / ANTHROPIC_API_KEY", async () => {
    const { out } = await captureStdout(() =>
      runInit({
        repoRoot,
        configPath,
        runCmd: fullPassRunner(),
        env: {},
        nonInteractive: true,
        yes: true,
      }),
    );
    expect(out).not.toMatch(/OPENAI_API_KEY/);
    expect(out).not.toMatch(/ANTHROPIC_API_KEY/);
  });

  it("doctor output contains no OPENAI_API_KEY / ANTHROPIC_API_KEY", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        acpx: { bin: "acpx", version: ">=0.12.0 <0.13.0" },
        agents: { builder: "opencode", validator: "pi" },
      }),
    );
    const { out } = await captureStdout(() =>
      runDoctor({ repoRoot, configPath, runCmd: fullPassRunner(), env: {} }),
    );
    expect(out).not.toMatch(/OPENAI_API_KEY/);
    expect(out).not.toMatch(/ANTHROPIC_API_KEY/);
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
      env: {},
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
