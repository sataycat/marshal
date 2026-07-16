import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConfiguredAgent } from "./configured-agent.js";
import { SdkAcpAgentAdapter } from "./sdk-adapter.js";

const previousConfig = process.env.MARSHAL_GLOBAL_CONFIG;

afterEach(() => {
  if (previousConfig === undefined) delete process.env.MARSHAL_GLOBAL_CONFIG;
  else process.env.MARSHAL_GLOBAL_CONFIG = previousConfig;
});

describe("createConfiguredAgent", () => {
  it("rejects retired string role entries", () => {
    const path = join(mkdtempSync(join(tmpdir(), "marshal-agent-config-")), "config.json");
    writeFileSync(path, JSON.stringify({ agents: { builder: "opencode" } }));
    process.env.MARSHAL_GLOBAL_CONFIG = path;

    expect(() => createConfiguredAgent("builder")).toThrow(
      /String agent IDs are no longer supported/,
    );
  });

  it("selects the direct SDK adapter for a structured role command", () => {
    const path = join(mkdtempSync(join(tmpdir(), "marshal-agent-config-")), "config.json");
    writeFileSync(
      path,
      JSON.stringify({
        agents: { builder: { id: "opencode", command: "opencode", args: ["acp"] } },
      }),
    );
    process.env.MARSHAL_GLOBAL_CONFIG = path;

    expect(createConfiguredAgent("builder")).toBeInstanceOf(SdkAcpAgentAdapter);
  });
});
