import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_RETRIES,
  InvalidAgentIdError,
  resolveAgentId,
  resolveMaxRetries,
  type GlobalConfig,
} from "./config.js";

const originalEnv = process.env.MARSHAL_GLOBAL_CONFIG;

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.MARSHAL_GLOBAL_CONFIG;
  } else {
    process.env.MARSHAL_GLOBAL_CONFIG = originalEnv;
  }
});

describe("resolveAgentId", () => {
  it("defaults the validator to 'pi' when no config is provided", () => {
    expect(resolveAgentId("validator", {})).toBe("pi");
  });

  it("defaults the builder to 'opencode' when no config is provided", () => {
    expect(resolveAgentId("builder", {})).toBe("opencode");
  });

  it("returns the configured validator when set to 'opencode'", () => {
    const config: GlobalConfig = { agents: { validator: "opencode" } };
    expect(resolveAgentId("validator", config)).toBe("opencode");
  });

  it("returns the configured builder when set to 'pi'", () => {
    const config: GlobalConfig = { agents: { builder: "pi" } };
    expect(resolveAgentId("builder", config)).toBe("pi");
  });

  it("ignores the other role's field", () => {
    const config: GlobalConfig = { agents: { builder: "pi" } };
    expect(resolveAgentId("validator", config)).toBe("pi");
  });

  it("throws InvalidAgentIdError for an unknown validator id", () => {
    const config: GlobalConfig = { agents: { validator: "claude" } };
    expect(() => resolveAgentId("validator", config)).toThrow(InvalidAgentIdError);
  });

  it("throws InvalidAgentIdError for an unknown builder id", () => {
    const config: GlobalConfig = { agents: { builder: "gemini" } };
    expect(() => resolveAgentId("builder", config)).toThrow(InvalidAgentIdError);
  });
});

describe("resolveMaxRetries", () => {
  it("defaults to 2 when no config is provided", () => {
    expect(resolveMaxRetries({})).toBe(DEFAULT_MAX_RETRIES);
  });

  it("returns the configured value", () => {
    const config: GlobalConfig = { policy: { maxRetries: 5 } };
    expect(resolveMaxRetries(config)).toBe(5);
  });

  it("defaults when the configured value is negative", () => {
    const config: GlobalConfig = { policy: { maxRetries: -1 } };
    expect(resolveMaxRetries(config)).toBe(DEFAULT_MAX_RETRIES);
  });

  it("defaults when the configured value is not an integer", () => {
    const config: GlobalConfig = { policy: { maxRetries: 1.5 } };
    expect(resolveMaxRetries(config)).toBe(DEFAULT_MAX_RETRIES);
  });
});
