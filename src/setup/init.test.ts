import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDoctor, runInit } from "./init.js";
import { AGENT_ID_DEFAULTS } from "../worktree/config.js";
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

// ADR-024 Decision 3: init no longer probes agents. The runner only needs
// to satisfy Phase 1 (node/git/pnpm) and Phase 2 (which acpx / acpx --version).
function fullPassRunner(): CommandRunner {
  return fakeRunner((bin, args) => {
    if (bin === "node") return ok("v20.10.0\n");
    if (bin === "git") return ok("git version 2.40.0\n");
    if (bin === "pnpm") return ok("9.0.0\n");
    if (bin === "which" && args[0] === "acpx") return ok("/usr/local/bin/acpx\n");
    if (bin === "acpx" && args[0] === "--version") return ok("0.12.1\n");
    return "notfound";
  });
}

// Runner that also handles the session probe (for `marshal doctor` tests).
function fullPassRunnerWithAgents(): CommandRunner {
  return fakeRunner((bin, args) => {
    if (bin === "node") return ok("v20.10.0\n");
    if (bin === "git") return ok("git version 2.40.0\n");
    if (bin === "pnpm") return ok("9.0.0\n");
    if (bin === "which" && args[0] === "acpx") return ok("/usr/local/bin/acpx\n");
    if (bin === "acpx" && args[0] === "--version") return ok("0.12.1\n");
    // ADR-024 Decision 2: session probe via `acpx <agent> sessions new`.
    if (bin === "acpx" && args[0] === "--cwd" && args.includes("sessions") && args.includes("new"))
      return ok(JSON.stringify({ recordId: "rec-probe", name: "probe-session" }) + "\n");
    if (bin === "acpx" && args[0] === "--cwd" && args.includes("sessions") && args.includes("close"))
      return ok("");
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
    });

    expect(result.ok).toBe(true);
    expect(result.skippedMachine).toBe(true);
    expect(existsSync(join(repoRoot, ".marshal", "state.db"))).toBe(true);
  });

  // ADR-024 Decision 3: init is always non-interactive. No prompts, no flags.
  // It writes config + repo state unconditionally when the machine is not
  // already configured.
  it("writes config and repo state with AGENT_ID_DEFAULTS on a fresh machine", async () => {
    const result = await runInit({
      repoRoot,
      configPath,
      runCmd: fullPassRunner(),
    });

    expect(result.ok).toBe(true);
    expect(result.skippedMachine).toBe(false);
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(join(repoRoot, ".marshal", "state.db"))).toBe(true);

    const written = JSON.parse(readFileSync(configPath, "utf8"));
    expect(written.agents.builder).toBe(AGENT_ID_DEFAULTS.builder);
    expect(written.agents.validator).toBe(AGENT_ID_DEFAULTS.validator);
    expect(written.agents.specAuthor).toBe(AGENT_ID_DEFAULTS.specAuthor);
    expect(written.acpx.version).toBe(">=0.12.0 <0.13.0");
  });

  it("preserves existing config keys and fills missing roles with defaults", async () => {
    writeFileSync(configPath, JSON.stringify({ agents: { builder: "codex" } }));

    const result = await runInit({
      repoRoot,
      configPath,
      runCmd: fullPassRunner(),
    });

    expect(result.ok).toBe(true);
    const written = JSON.parse(readFileSync(configPath, "utf8"));
    // Existing key preserved.
    expect(written.agents.builder).toBe("codex");
    // Missing roles filled from defaults.
    expect(written.agents.validator).toBe(AGENT_ID_DEFAULTS.validator);
    expect(written.agents.specAuthor).toBe(AGENT_ID_DEFAULTS.specAuthor);
  });

  // ADR-024 Decision 1: acpx is a hard gate. Missing acpx → one install
  // command line, exit non-zero, no install attempt, no fake `✓`.
  it("halts with one install-command line when acpx is missing", async () => {
    const runCmd = fakeRunner((bin) => {
      if (bin === "node") return ok("v20.10.0\n");
      if (bin === "git") return ok("git version 2.40.0\n");
      if (bin === "pnpm") return ok("9.0.0\n");
      return "notfound";
    });

    const { out, ret } = await captureStdout(() =>
      runInit({ repoRoot, configPath, runCmd }),
    );

    expect(ret.ok).toBe(false);
    expect(ret.skippedMachine).toBe(false);
    // The install command with the pinned version appears.
    expect(out).toContain("npm i -g acpx@0.12.0");
    // No fake `✓ npm i -g acpx` success marker (ADR-024 Issue A).
    expect(out).not.toMatch(/✓ npm i -g acpx/);
    // No files written.
    expect(existsSync(join(repoRoot, ".marshal", "state.db"))).toBe(false);
    expect(existsSync(configPath)).toBe(false);
  });

  // ADR-024 Decision 1: no re-probe loop, no continuation into agent probes.
  it("does not probe agents when acpx is missing", async () => {
    const calls: string[] = [];
    const runCmd = fakeRunner((bin, args) => {
      calls.push(`${bin} ${args.join(" ")}`);
      if (bin === "node") return ok("v20.10.0\n");
      if (bin === "git") return ok("git version 2.40.0\n");
      if (bin === "pnpm") return ok("9.0.0\n");
      return "notfound";
    });

    await runInit({ repoRoot, configPath, runCmd });

    // Phase 2 should run (which acpx / acpx --version), but no agent probes.
    expect(calls.some((c) => /^which acpx/.test(c))).toBe(true);
    expect(calls.some((c) => /^acpx --version/.test(c))).toBe(true);
    // No `acpx <agent> sessions new` calls.
    expect(calls.some((c) => /sessions new/.test(c))).toBe(false);
  });

  // ADR-024 Decision 3: init does not probe agents at all (Phase 3 removed).
  // Agent verification is `marshal doctor`'s job.
  it("does not probe agents even when acpx is present", async () => {
    const calls: string[] = [];
    const runCmd = fakeRunner((bin, args) => {
      calls.push(`${bin} ${args.join(" ")}`);
      if (bin === "node") return ok("v20.10.0\n");
      if (bin === "git") return ok("git version 2.40.0\n");
      if (bin === "pnpm") return ok("9.0.0\n");
      if (bin === "which" && args[0] === "acpx") return ok("/usr/local/bin/acpx\n");
      if (bin === "acpx" && args[0] === "--version") return ok("0.12.1\n");
      return "notfound";
    });

    await runInit({ repoRoot, configPath, runCmd });

    // No `acpx <agent> sessions new` or `acpx <agent> exec` calls.
    expect(calls.some((c) => /sessions new/.test(c))).toBe(false);
    expect(calls.some((c) => /sessions close/.test(c))).toBe(false);
  });

  it("exits non-zero when Phase 1 fails (node missing)", async () => {
    const runCmd = fakeRunner(() => "notfound");

    const result = await runInit({ repoRoot, configPath, runCmd });

    expect(result.ok).toBe(false);
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(join(repoRoot, ".marshal", "state.db"))).toBe(false);
  });

  it("re-running init when the machine is already configured takes the fast path", async () => {
    // First run: writes config + repo state.
    await runInit({ repoRoot, configPath, runCmd: fullPassRunner() });
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(join(repoRoot, ".marshal", "state.db"))).toBe(true);

    // Second run: fast path (machine already configured).
    const { out, ret } = await captureStdout(() =>
      runInit({ repoRoot, configPath, runCmd: fullPassRunner() }),
    );

    expect(ret.ok).toBe(true);
    expect(ret.skippedMachine).toBe(true);
    expect(out).toContain("machine already configured");
  });

  it("writes config with the exact install pin version, not the wide accept range", async () => {
    const runCmd = fakeRunner((bin) => {
      if (bin === "node") return ok("v20.10.0\n");
      if (bin === "git") return ok("git version 2.40.0\n");
      if (bin === "pnpm") return ok("9.0.0\n");
      return "notfound";
    });

    // This test verifies the install hint in the acpx-missing path uses the pin.
    const { out } = await captureStdout(() =>
      runInit({ repoRoot, configPath, runCmd }),
    );

    // The install command uses the pin (0.12.0), not the range (>=0.12.0 <0.13.0).
    expect(out).toContain("acpx@0.12.0");
    expect(out).not.toContain("acpx@>=0.12.0");
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

  it("init output contains no OPENAI_API_KEY / ANTHROPIC_API_KEY", async () => {
    const { out } = await captureStdout(() =>
      runInit({ repoRoot, configPath, runCmd: fullPassRunner() }),
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
      runDoctor({ repoRoot, configPath, runCmd: fullPassRunnerWithAgents() }),
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
      runCmd: fullPassRunnerWithAgents(),
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
    });
    expect(result.ok).toBe(false);
    expect(existsSync(join(repoRoot, ".marshal"))).toBe(false);
  });

  // ADR-024 Decision 2: doctor probes agents via the zero-cost session probe.
  it("probes configured agents via sessions new + sessions close", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        acpx: { bin: "acpx", version: ">=0.12.0 <0.13.0" },
        agents: { builder: "opencode", validator: "pi" },
      }),
    );
    const calls: string[] = [];
    const runCmd = fakeRunner((bin, args) => {
      calls.push(`${bin} ${args.join(" ")}`);
      if (bin === "node") return ok("v20.10.0\n");
      if (bin === "git") return ok("git version 2.40.0\n");
      if (bin === "pnpm") return ok("9.0.0\n");
      if (bin === "which" && args[0] === "acpx") return ok("/usr/local/bin/acpx\n");
      if (bin === "acpx" && args[0] === "--version") return ok("0.12.1\n");
      if (bin === "acpx" && args[0] === "--cwd" && args.includes("sessions") && args.includes("new"))
        return ok(JSON.stringify({ recordId: "rec-probe", name: "probe-session" }) + "\n");
      if (bin === "acpx" && args[0] === "--cwd" && args.includes("sessions") && args.includes("close"))
        return ok("");
      return "notfound";
    });

    const result = await runDoctor({ repoRoot, configPath, runCmd });
    expect(result.ok).toBe(true);
    // Both agents were probed via sessions new.
    expect(calls.some((c) => /opencode sessions new/.test(c))).toBe(true);
    expect(calls.some((c) => /pi sessions new/.test(c))).toBe(true);
    // Both sessions were closed.
    expect(calls.some((c) => /sessions close/.test(c))).toBe(true);
  });
});
