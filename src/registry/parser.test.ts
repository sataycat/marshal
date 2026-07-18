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
});
