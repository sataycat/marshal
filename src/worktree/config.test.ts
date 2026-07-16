import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DAEMON_HOST,
  DEFAULT_DAEMON_PORT,
  DEFAULT_MAX_RETRIES,
  MissingAgentIdError,
  resolveAgentId,
  resolveAgentCommand,
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

describe("resolveAgentId (ADR-023: no per-role defaults)", () => {
  it("throws MissingAgentIdError when no agent is configured for the role", () => {
    expect(() => resolveAgentId("builder", {})).toThrow(MissingAgentIdError);
    const err = (() => {
      try {
        resolveAgentId("builder", {});
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err?.message).toContain("agents.builder");
    expect(err?.message).toContain("direct ACP command");
  });

  it("throws MissingAgentIdError for validator when only builder is set", () => {
    expect(() =>
      resolveAgentId("validator", {
        agents: { builder: { id: "codex", command: "codex-acp", args: [] } },
      }),
    ).toThrow(MissingAgentIdError);
  });

  it("throws MissingAgentIdError for specAuthor without falling back to builder", () => {
    expect(() =>
      resolveAgentId("specAuthor", {
        agents: {
          builder: { id: "codex", command: "codex-acp", args: [] },
          validator: { id: "claude", command: "claude-acp", args: [] },
        },
      }),
    ).toThrow(MissingAgentIdError);
  });

  it("returns the configured builder id", () => {
    const config: GlobalConfig = {
      agents: { builder: { id: "codex", command: "codex-acp", args: [] } },
    };
    expect(resolveAgentId("builder", config)).toBe("codex");
  });

  it("returns the configured validator id", () => {
    const config: GlobalConfig = {
      agents: { validator: { id: "claude", command: "claude-acp", args: [] } },
    };
    expect(resolveAgentId("validator", config)).toBe("claude");
  });

  it("returns the configured specAuthor id", () => {
    const config: GlobalConfig = {
      agents: { specAuthor: { id: "opencode", command: "opencode", args: ["acp"] } },
    };
    expect(resolveAgentId("specAuthor", config)).toBe("opencode");
  });

  it("passes through a custom agent id end-to-end (ADR-019)", () => {
    const config: GlobalConfig = {
      agents: { builder: { id: "claude-code", command: "claude-agent-acp", args: [] } },
    };
    expect(resolveAgentId("builder", config)).toBe("claude-code");
  });

  it("resolves the id and command from a direct ACP configuration", () => {
    const command = { id: "opencode", command: "npx", args: ["-y", "opencode-ai", "acp"] };
    const config: GlobalConfig = { agents: { builder: command } };
    expect(resolveAgentId("builder", config)).toBe("opencode");
    expect(resolveAgentCommand("builder", config)).toEqual(command);
  });

  it("rejects a retired string configuration", () => {
    expect(() =>
      resolveAgentCommand("builder", { agents: { builder: "codex" } } as unknown as GlobalConfig),
    ).toThrow(/String agent IDs are no longer supported/);
  });

  it("exposes the role on the error", () => {
    try {
      resolveAgentId("validator", {});
    } catch (e) {
      expect((e as MissingAgentIdError).role).toBe("validator");
    }
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
