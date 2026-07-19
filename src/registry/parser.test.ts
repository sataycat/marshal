import { describe, expect, it } from "vitest";
import { parseRegistryDocument } from "./parser.js";

describe("registry parser", () => {
  it("accepts the current ACP Registry distribution field names", () => {
    const parsed = parseRegistryDocument({
      version: "1.0.0",
      agents: [
        {
          id: "example",
          name: "Example",
          version: "1.0.0",
          description: "An example ACP agent",
          authors: [],
          license: "MIT",
          distribution: {
            binary: {
              "linux-x86_64": {
                archive: "https://example.test/agent.tar.gz",
                cmd: "./agent",
                sha256: "a".repeat(64),
              },
            },
          },
        },
      ],
    });

    expect(parsed.agents[0]?.distributions[0]).toMatchObject({
      kind: "binary",
      archive_url: "https://example.test/agent.tar.gz",
      archive_format: "tar.gz",
      executable: "./agent",
      checksum: "a".repeat(64),
    });
  });

  it("accepts Windows platform names published by the registry", () => {
    const parsed = parseRegistryDocument({
      version: "1.0.0",
      agents: [
        {
          id: "windows-agent",
          name: "Windows Agent",
          version: "1.0.0",
          description: "An example ACP agent",
          authors: [],
          license: "MIT",
          distribution: {
            binary: {
              "windows-x86_64": {
                archive: "https://example.test/agent.zip",
                cmd: "agent.exe",
              },
              "windows-aarch64": {
                archive: "https://example.test/agent-arm.zip",
                cmd: "agent.exe",
              },
            },
          },
        },
      ],
    });

    expect(parsed.agents[0]?.distributions.map((distribution) => distribution.platforms)).toEqual([
      ["windows-x86_64"],
      ["windows-aarch64"],
    ]);
  });

  it("accepts direct executable downloads without archive suffixes", () => {
    const parsed = parseRegistryDocument({
      version: "1.0.0",
      agents: [
        {
          id: "direct-agent",
          name: "Direct Agent",
          version: "1.0.0",
          description: "An example ACP agent",
          authors: [],
          license: "MIT",
          distribution: {
            binary: {
              "linux-x86_64": {
                archive: "https://example.test/agent-linux-amd64",
                cmd: "agent-linux-amd64",
              },
            },
          },
        },
      ],
    });

    expect(parsed.agents[0]?.distributions[0]).toMatchObject({
      kind: "binary",
      archive_url: "https://example.test/agent-linux-amd64",
      executable: "agent-linux-amd64",
    });
    expect(parsed.agents[0]?.distributions[0]?.archive_format).toBeUndefined();
  });
});
