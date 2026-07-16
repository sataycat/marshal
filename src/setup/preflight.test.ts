import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
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
    if (out === "notfound") return { code: null, stdout: "", stderr: "", notFound: true };
    return { ...out, notFound: false };
  };
}

function ok(stdout = ""): CommandResult {
  return { code: 0, stdout, stderr: "", notFound: false };
}

const opencode = { id: "opencode", command: "npx", args: ["-y", "opencode-ai", "acp"] };
const pi = { id: "pi", command: "npx", args: ["-y", "pi-acp"] };

describe("checkSystemPrerequisites", () => {
  it("reports ok when node, git, and pnpm are present", async () => {
    const run = fakeRunner((bin) => {
      if (bin === "node") return ok("v20.10.0\n");
      if (bin === "git") return ok("git version 2.40.0\n");
      if (bin === "pnpm") return ok("9.0.0\n");
      return "notfound";
    });
    const results = await checkSystemPrerequisites(run);
    expect(results.every((result) => result.status === "ok")).toBe(true);
  });

  it("fails for an old Node version and warns for missing pnpm", async () => {
    const run = fakeRunner((bin) => {
      if (bin === "node") return ok("v16.20.0\n");
      if (bin === "git") return ok("git version 2.40.0\n");
      return "notfound";
    });
    const results = await checkSystemPrerequisites(run);
    expect(results.find((result) => result.label.startsWith("node"))?.status).toBe("fail");
    expect(results.find((result) => result.label === "pnpm")?.status).toBe("warning");
  });
});

describe("direct config generation", () => {
  it("generates structured commands without an ACPX section", () => {
    expect(generateConfig({ builder: opencode, validator: pi, specAuthor: opencode })).toEqual({
      agents: { builder: opencode, validator: pi, specAuthor: opencode },
      policy: { maxRetries: 2 },
    });
  });

  it("preserves existing structured roles and replaces legacy strings", () => {
    const custom = { id: "custom", command: "custom-acp", args: [] };
    const existing = {
      agents: { builder: custom, validator: "pi" },
      policy: { maxRetries: 5 },
    } as never;
    const merged = mergeConfig(existing, generateConfig({ builder: opencode, validator: pi }));
    expect(merged.agents).toEqual({ builder: custom, validator: pi });
    expect(merged.policy?.maxRetries).toBe(5);
  });
});

describe("machineAlreadyConfigured", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "marshal-config-"));
  });

  it("accepts complete direct commands", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ agents: { builder: opencode, validator: pi } }));
    expect(machineAlreadyConfigured(path)).toBe(true);
  });

  it("rejects retired string roles", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ agents: { builder: "opencode", validator: "pi" } }));
    expect(machineAlreadyConfigured(path)).toBe(false);
  });
});

describe("formatCheckLine", () => {
  it("renders details and remediation", () => {
    expect(
      formatCheckLine({
        label: "agent",
        status: "fail",
        detail: "missing",
        fix: "configure command",
        docs: "https://agentclientprotocol.com",
      }),
    ).toContain("fix: configure command");
  });
});
