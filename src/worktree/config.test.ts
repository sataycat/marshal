import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DAEMON_HOST,
  DEFAULT_DAEMON_PORT,
  DEFAULT_MAX_RETRIES,
  resolveAgentId,
  resolveDaemonBind,
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

  it("passes through a custom validator id without validation", () => {
    const config: GlobalConfig = { agents: { validator: "claude" } };
    expect(resolveAgentId("validator", config)).toBe("claude");
  });

  it("passes through a custom builder id without validation", () => {
    const config: GlobalConfig = { agents: { builder: "gemini" } };
    expect(resolveAgentId("builder", config)).toBe("gemini");
  });

  it("passes through a custom agent id end-to-end (ADR-019)", () => {
    const config: GlobalConfig = { agents: { builder: "claude-code" } };
    expect(resolveAgentId("builder", config)).toBe("claude-code");
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

describe("resolveDaemonBind", () => {
  it("defaults to 127.0.0.1 and 7433 with no config or flags", () => {
    const bind = resolveDaemonBind({}, {});
    expect(bind).toEqual({ host: DEFAULT_DAEMON_HOST, port: DEFAULT_DAEMON_PORT });
  });

  it("uses flags over config over defaults", () => {
    expect(resolveDaemonBind({ port: 9999 }, { daemon: { port: 8888 } })).toEqual({
      host: DEFAULT_DAEMON_HOST,
      port: 9999,
    });
  });

  it("uses config.daemon.port when no flag is passed", () => {
    expect(resolveDaemonBind({}, { daemon: { port: 8888 } })).toEqual({
      host: DEFAULT_DAEMON_HOST,
      port: 8888,
    });
  });

  it("uses config.daemon.host when no flag is passed", () => {
    expect(resolveDaemonBind({}, { daemon: { host: "::1" } })).toEqual({
      host: "::1",
      port: DEFAULT_DAEMON_PORT,
    });
  });

  it("accepts port 0 as an ephemeral binding", () => {
    expect(resolveDaemonBind({ port: 0 }, {})).toEqual({
      host: DEFAULT_DAEMON_HOST,
      port: 0,
    });
  });

  it("falls back to the default port when the configured port is out of range", () => {
    expect(resolveDaemonBind({}, { daemon: { port: 99999 } })).toEqual({
      host: DEFAULT_DAEMON_HOST,
      port: DEFAULT_DAEMON_PORT,
    });
  });
});
