import { describe, expect, it } from "vitest";
import { parseRegistryDocument, RegistryValidationError } from "./parser.js";

const agent = { id: "demo", name: "Demo", version: "1.2.3", description: "A demo agent", license: "MIT", distribution: { npx: { package: "demo@1.2.3", args: ["--acp"] } } };

describe("registry parser", () => {
  it("keeps safe metadata and ignores unknown fields and launch arguments", () => {
    const parsed = parseRegistryDocument({ version: "1.0.0", agents: [{ ...agent, future_field: { ignored: true } }], extensions: [{ unknown: true }] });
    expect(parsed.agents[0]).toEqual(expect.objectContaining({ id: "demo", distributions: [{ kind: "npx", package: "demo@1.2.3" }] }));
    expect(parsed.agents[0]).not.toHaveProperty("future_field");
  });

  it("rejects unsupported versions and missing required metadata", () => {
    expect(() => parseRegistryDocument({ version: "2.0.0", agents: [] })).toThrow(RegistryValidationError);
    expect(() => parseRegistryDocument({ version: "1.0.0", agents: [{ ...agent, description: "" }] })).toThrow(/description/);
    expect(() => parseRegistryDocument({ version: "1.0.0", agents: [{ ...agent, distribution: {} }] })).toThrow(/distribution/);
  });

  it("preserves complete binary metadata and validates checksumless records", () => {
    const parsed = parseRegistryDocument({ version: "1.0.0", agents: [{ ...agent, distribution: {
      npx: { package: "demo@1.2.3", args: ["--acp"] },
      uvx: { package: "demo==1.2.3", args: ["--acp"] },
      binary: { "linux-x64": { url: "https://example.com/demo.tar.gz", format: "tar.gz", checksum: "sha256:" + "a".repeat(64), executable: "bin/demo", args: ["--acp"], env: { DEMO_MODE: "acp" } }, "darwin-arm64": { url: "https://example.com/demo.zip", format: "zip", executable: "demo" } },
      safe_unknown: { retained: false },
     } }] });
    expect(parsed.agents[0].distributions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "npx", package: "demo@1.2.3", args: ["--acp"] }),
      expect.objectContaining({ kind: "uvx", package: "demo==1.2.3", args: ["--acp"] }),
      expect.objectContaining({ kind: "binary", platforms: ["linux-x64"], checksum: "a".repeat(64), executable: "bin/demo", env: { DEMO_MODE: "acp" } }),
      expect.objectContaining({ kind: "binary", platforms: ["darwin-arm64"], checksum: undefined }),
    ]));
  });

  it.each([
    ["unsafe executable", { executable: "../demo" }],
    ["bad checksum", { checksum: "nope" }],
    ["bad url", { url: "file:///tmp/demo.zip" }],
    ["unsupported platform", { platform_key: "plan9-x64" }],
  ])("rejects %s binary metadata", (_name, override) => {
    const binary = { url: "https://example.com/demo.zip", format: "zip", executable: "demo", ...override };
    const distribution = "platform_key" in override ? { binary: { [(override as { platform_key: string }).platform_key]: binary } } : { binary: { "linux-x64": binary } };
    expect(() => parseRegistryDocument({ version: "1.0.0", agents: [{ ...agent, distribution }] })).toThrow(RegistryValidationError);
  });
});
