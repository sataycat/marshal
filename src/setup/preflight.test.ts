import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACPX_PINNED_VERSION,
  checkAcpx,
  checkAgent,
  checkAuthEnv,
  checkSystemPrerequisites,
  formatCheckLine,
  generateConfig,
  machineAlreadyConfigured,
  mergeConfig,
  type CommandResult,
  type CommandRunner,
} from "./preflight.js";

type Script = (bin: string, args: string[]) => CommandResult | "notfound";

function fakeRunner(script: Script): CommandRunner {
  return async (bin, args) => {
    const out = script(bin, args);
    if (out === "notfound") {
      return { code: null, stdout: "", stderr: "", notFound: true };
    }
    return { ...out, notFound: false };
  };
}

function ok(stdout = "", stderr = ""): CommandResult {
  return { code: 0, stdout, stderr, notFound: false };
}
function err(code: number, stderr = "", stdout = ""): CommandResult {
  return { code, stdout, stderr, notFound: false };
}

const originalEnv = process.env.MARSHAL_GLOBAL_CONFIG;

afterEach(() => {
  if (originalEnv === undefined) delete process.env.MARSHAL_GLOBAL_CONFIG;
  else process.env.MARSHAL_GLOBAL_CONFIG = originalEnv;
});

describe("checkSystemPrerequisites", () => {
  it("reports ok when node, git, and pnpm are present", async () => {
    const run = fakeRunner((bin, args) => {
      if (bin === "node" && args[0] === "--version") return ok("v20.10.0\n");
      if (bin === "git" && args[0] === "--version") return ok("git version 2.40.0\n");
      if (bin === "pnpm" && args[0] === "--version") return ok("9.0.0\n");
      return "notfound";
    });
    const results = await checkSystemPrerequisites(run);
    expect(results.every((r) => r.status === "ok")).toBe(true);
  });

  it("fails when node is below the required major", async () => {
    const run = fakeRunner((bin) => {
      if (bin === "node") return ok("v16.20.0\n");
      if (bin === "git") return ok("git version 2.40.0\n");
      if (bin === "pnpm") return ok("9.0.0\n");
      return "notfound";
    });
    const results = await checkSystemPrerequisites(run);
    const node = results.find((r) => r.label.startsWith("node"))!;
    expect(node.status).toBe("fail");
    expect(node.detail).toContain("v16.20.0");
  });

  it("fails when git is missing (non-negotiable)", async () => {
    const run = fakeRunner((bin) => {
      if (bin === "node") return ok("v20.10.0\n");
      if (bin === "git") return "notfound";
      if (bin === "pnpm") return ok("9.0.0\n");
      return "notfound";
    });
    const results = await checkSystemPrerequisites(run);
    const git = results.find((r) => r.label === "git")!;
    expect(git.status).toBe("fail");
  });

  it("warns (not fails) when pnpm is missing", async () => {
    const run = fakeRunner((bin) => {
      if (bin === "node") return ok("v20.10.0\n");
      if (bin === "git") return ok("git version 2.40.0\n");
      if (bin === "pnpm") return "notfound";
      return "notfound";
    });
    const results = await checkSystemPrerequisites(run);
    const pnpm = results.find((r) => r.label === "pnpm")!;
    expect(pnpm.status).toBe("warning");
    expect(pnpm.fix).toBe("npm i -g pnpm");
  });
});

describe("checkAcpx", () => {
  it("passes when acpx is on PATH and in range", async () => {
    const run = fakeRunner((bin, args) => {
      if (bin === "which" && args[0] === "acpx") return ok("/usr/local/bin/acpx\n");
      if (bin === "acpx" && args[0] === "--version") return ok("0.12.1\n");
      return "notfound";
    });
    const results = await checkAcpx(run, { binPath: "acpx", versionRange: ACPX_PINNED_VERSION });
    expect(results.every((r) => r.status === "ok")).toBe(true);
  });

  it("fails when acpx is not on PATH", async () => {
    const run = fakeRunner(() => "notfound");
    const results = await checkAcpx(run, { binPath: "acpx", versionRange: ACPX_PINNED_VERSION });
    const path = results.find((r) => r.label === "acpx")!;
    expect(path.status).toBe("fail");
    expect(path.fix).toContain("npm i -g acpx@");
  });

  it("warns when acpx version is outside the range", async () => {
    const run = fakeRunner((bin, args) => {
      if (bin === "which") return ok("/usr/local/bin/acpx\n");
      if (bin === "acpx" && args[0] === "--version") return ok("0.13.0\n");
      return "notfound";
    });
    const results = await checkAcpx(run, { binPath: "acpx", versionRange: ">=0.12.0 <0.13.0" });
    const version = results.find((r) => r.label === "acpx version")!;
    expect(version.status).toBe("warning");
    expect(version.detail).toContain("0.13.0");
  });

  it("checks a configured bin path directly when not 'acpx'", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "marshal-acpx-"));
    const binPath = join(tmp, "acpx");
    writeFileSync(binPath, "#!/bin/sh\necho 0.12.0\n", { mode: 0o755 });
    const run = fakeRunner((bin, args) => {
      if (bin === binPath && args[0] === "--version") return ok("0.12.0\n");
      return "notfound";
    });
    const results = await checkAcpx(run, { binPath, versionRange: ">=0.12.0 <0.13.0" });
    expect(results.find((r) => r.label === "acpx")?.status).toBe("ok");
    expect(results.find((r) => r.label === "acpx version")?.status).toBe("ok");
  });
});

describe("checkAgent", () => {
  it("passes when the agent responds to --version and the handshake", async () => {
    const run = fakeRunner((bin, args) => {
      if (bin === "acpx" && args[0] === "opencode" && args[1] === "--version") return ok("1.0.0\n");
      if (bin === "acpx" && args[0] === "opencode" && args[1] === "exec") return ok("hi\n");
      return "notfound";
    });
    const tmp = mkdtempSync(join(tmpdir(), "marshal-agent-"));
    const result = await checkAgent(run, "opencode", "acpx", "builder", tmp);
    expect(result.installed.status).toBe("ok");
    expect(result.handshake.status).toBe("ok");
  });

  it("fails install with the curated npm package hint for a known agent", async () => {
    const run = fakeRunner((bin, args) => {
      if (bin === "acpx" && args[0] === "opencode" && args[1] === "--version")
        return err(1, "no such agent");
      return "notfound";
    });
    const tmp = mkdtempSync(join(tmpdir(), "marshal-agent-"));
    const result = await checkAgent(run, "opencode", "acpx", "builder", tmp);
    expect(result.installed.status).toBe("fail");
    expect(result.installed.fix).toBe("npm i -g opencode-ai");
    expect(result.installed.docs).toBe("https://github.com/nicholasgriffintn/opencode");
  });

  it("warns (does not fail) when the handshake fails — likely auth", async () => {
    const run = fakeRunner((bin, args) => {
      if (bin === "acpx" && args[0] === "opencode" && args[1] === "--version") return ok("1.0.0\n");
      if (bin === "acpx" && args[0] === "opencode" && args[1] === "exec")
        return err(1, "auth error");
      return "notfound";
    });
    const tmp = mkdtempSync(join(tmpdir(), "marshal-agent-"));
    const result = await checkAgent(run, "opencode", "acpx", "builder", tmp);
    expect(result.installed.status).toBe("ok");
    expect(result.handshake.status).toBe("warning");
    expect(result.handshake.detail).toContain("auth");
  });

  it("asks the user to install manually for an unknown agent id", async () => {
    const run = fakeRunner((bin, args) => {
      if (bin === "acpx" && args[0] === "custom-agent" && args[1] === "--version")
        return err(1, "no such agent");
      return "notfound";
    });
    const tmp = mkdtempSync(join(tmpdir(), "marshal-agent-"));
    const result = await checkAgent(run, "custom-agent", "acpx", "builder", tmp);
    expect(result.installed.status).toBe("fail");
    expect(result.installed.fix).toContain("install the 'custom-agent' agent");
  });
});

describe("checkAuthEnv", () => {
  it("is ok when the expected env var is present", () => {
    expect(checkAuthEnv("opencode", { OPENAI_API_KEY: "sk-x" })?.status).toBe("ok");
  });

  it("warns when the expected env var is missing", () => {
    const r = checkAuthEnv("pi", {});
    expect(r?.status).toBe("warning");
    expect(r?.detail).toContain("ANTHROPIC_API_KEY");
    expect(r?.docs).toBe("https://console.anthropic.com/settings/keys");
  });

  it("returns null for an unknown agent", () => {
    expect(checkAuthEnv("custom-agent", {})).toBeNull();
  });
});

describe("config generation and merge", () => {
  it("generates a config from detected state", () => {
    const config = generateConfig({
      acpxBin: "acpx",
      versionRange: ">=0.12.0 <0.13.0",
      builder: "opencode",
      validator: "pi",
    });
    expect(config).toEqual({
      acpx: { bin: "acpx", version: ">=0.12.0 <0.13.0" },
      agents: { builder: "opencode", validator: "pi" },
      policy: { maxRetries: 2 },
    });
  });

  it("merge fills missing keys while preserving existing ones", () => {
    const existing = { agents: { builder: "claude-code" }, policy: { maxRetries: 5 } };
    const patch = generateConfig({
      acpxBin: "acpx",
      versionRange: ">=0.12.0 <0.13.0",
      builder: "opencode",
      validator: "pi",
    });
    const merged = mergeConfig(existing, patch);
    expect(merged.agents?.builder).toBe("claude-code");
    expect(merged.agents?.validator).toBe("pi");
    expect(merged.policy?.maxRetries).toBe(5);
    expect(merged.acpx?.bin).toBe("acpx");
  });
});

describe("machineAlreadyConfigured", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "marshal-mc-"));
  });

  it("is false when the config file is absent", () => {
    expect(machineAlreadyConfigured(join(dir, "config.json"))).toBe(false);
  });

  it("is true when the config has acpx and both agent roles", () => {
    const path = join(dir, "config.json");
    writeFileSync(
      path,
      JSON.stringify({
        acpx: { bin: "acpx", version: ">=0.12.0 <0.13.0" },
        agents: { builder: "opencode", validator: "pi" },
      }),
    );
    expect(machineAlreadyConfigured(path)).toBe(true);
  });

  it("is false when the config is partial (missing acpx / agent roles)", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ agents: { builder: "opencode" } }));
    expect(machineAlreadyConfigured(path)).toBe(false);
  });

  it("is false when the config file is unparseable", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, "{ not json");
    expect(machineAlreadyConfigured(path)).toBe(false);
  });
});

describe("formatCheckLine", () => {
  it("renders an ok line with detail", () => {
    expect(formatCheckLine({ label: "node", status: "ok", detail: "v20.10.0" })).toBe(
      "✓ node (v20.10.0)",
    );
  });

  it("renders a fail line with fix and docs", () => {
    const line = formatCheckLine({
      label: "acpx",
      status: "fail",
      detail: "not on PATH",
      fix: "npm i -g acpx",
      docs: "https://example.com",
    });
    expect(line).toContain("✗ acpx");
    expect(line).toContain("fix: npm i -g acpx");
    expect(line).toContain("docs: https://example.com");
  });

  it("renders a warning line", () => {
    expect(formatCheckLine({ label: "pnpm", status: "warning", detail: "not found" })).toContain(
      "⚠",
    );
  });
});
