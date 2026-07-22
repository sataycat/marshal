import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { probeAgent } from "./probe.js";

const FAKE_AGENT = `#!/usr/bin/env node
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    if (process.env.FAKE_PROBE_PROTOCOL === '1') { send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 999 } }); return; }
    send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: msg.params.protocolVersion,
      agentCapabilities: { promptCapabilities: { image: true }, sessionCapabilities: { close: {} } },
      authMethods: process.env.FAKE_PROBE_AUTH === '1' ? [
        { id: 'login', name: 'Browser login', description: 'Use the browser', _meta: { fixture: true }, futureField: { retained: true } },
        { id: 'key', type: 'env_var', name: 'API key', description: 'Paste a key', vars: [{ name: 'API_KEY', label: 'API key', secret: true, optional: false, _meta: { input: 'token' }, futureVar: 1 }, { name: 'PROFILE', secret: false, optional: true }], link: 'https://example.test/keys', _meta: { fixture: 'env' }, futureEnv: true },
        { id: 'terminal', type: 'terminal', name: 'Terminal login', args: ['login'], env: { MODE: 'auth' }, _meta: { fixture: 'terminal' }, futureTerminal: true }
      ] : [],
      _meta: { fixture: 'initialize' },
    } });
  } else if (msg.method === 'session/new') {
    if (process.env.FAKE_PROBE_SESSION_ERROR === 'auth') send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Sign in through the agent', data: { methodId: 'login' } } });
    else if (process.env.FAKE_PROBE_SESSION_ERROR === 'ordinary') send({ jsonrpc: '2.0', id: msg.id, error: { code: -32001, message: 'Authentication required is only prose here', data: { retryable: false } } });
    else send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'probe-session' } });
  }
  else if (msg.method === 'session/close') send({ jsonrpc: '2.0', id: msg.id, result: {} });
});
`;

let fakeAgentPath: string;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "marshal-probe-agent-"));
  fakeAgentPath = join(dir, "agent.cjs");
  writeFileSync(fakeAgentPath, FAKE_AGENT, { mode: 0o755 });
  chmodSync(fakeAgentPath, 0o755);
});

describe("ACP readiness probe", () => {
  it("initializes a no-auth agent and creates a temporary session", async () => {
    const result = await probeAgent(mkdtempSync(join(tmpdir(), "marshal-probe-cwd-")), { command: "node" as "npx", args: [fakeAgentPath] });
    expect(result.status).toBe("ready");
    expect(result.protocol_version).toBeTypeOf("number");
    expect(result.capabilities?.prompt.image).toBe(true);
    expect(result.error).toBeNull();
  });

  it("creates a session when authentication methods are advertised", async () => {
    process.env.FAKE_PROBE_AUTH = "1";
    const result = await probeAgent(mkdtempSync(join(tmpdir(), "marshal-probe-auth-cwd-")), { command: "node" as "npx", args: [fakeAgentPath] });
    delete process.env.FAKE_PROBE_AUTH;
    expect(result.status).toBe("ready");
    expect(result.auth_methods[0]).toMatchObject({ id: "login", type: "agent" });
    expect(result.auth_methods).toMatchObject([
      { id: "login", meta: { fixture: true }, raw: { futureField: { retained: true } } },
      { id: "key", type: "env_var", link: "https://example.test/keys", vars: [{ name: "API_KEY", label: "API key", secret: true, optional: false, meta: { input: "token" }, raw: { futureVar: 1 } }, { name: "PROFILE", secret: false, optional: true }], raw: { futureEnv: true } },
      { id: "terminal", type: "terminal", args: ["login"], env: { MODE: "auth" }, raw: { futureTerminal: true } },
    ]);
    expect(result.raw_initialize).toMatchObject({ _meta: { fixture: "initialize" } });
  });

  it("maps only typed AuthRequired and preserves initialization and error metadata", async () => {
    process.env.FAKE_PROBE_AUTH = "1";
    process.env.FAKE_PROBE_SESSION_ERROR = "auth";
    try {
      const result = await probeAgent(mkdtempSync(join(tmpdir(), "marshal-probe-auth-required-cwd-")), { command: "node" as "npx", args: [fakeAgentPath] });
      expect(result).toMatchObject({
        status: "authentication_required",
        protocol_version: expect.any(Number),
        capabilities: { prompt: { image: true } },
        auth_methods: expect.any(Array),
        raw_initialize: { _meta: { fixture: "initialize" } },
        failure: { kind: "authentication_required", protocol_code: -32000, message: "Sign in through the agent", data: { methodId: "login" } },
      });
      expect(result.auth_methods[0]).toMatchObject({ id: "login", name: "Browser login" });
    } finally {
      delete process.env.FAKE_PROBE_AUTH;
      delete process.env.FAKE_PROBE_SESSION_ERROR;
    }
  });

  it("does not infer authentication from error prose and preserves non-auth failure metadata", async () => {
    process.env.FAKE_PROBE_AUTH = "1";
    process.env.FAKE_PROBE_SESSION_ERROR = "ordinary";
    try {
      const result = await probeAgent(mkdtempSync(join(tmpdir(), "marshal-probe-session-failure-cwd-")), { command: "node" as "npx", args: [fakeAgentPath] });
      expect(result).toMatchObject({
        status: "failed",
        protocol_version: expect.any(Number),
        auth_methods: expect.any(Array),
        raw_initialize: { _meta: { fixture: "initialize" } },
        failure: { kind: "agent_internal_error", protocol_code: -32001, message: "Authentication required is only prose here", data: { retryable: false } },
      });
      expect(result.auth_methods[0]).toMatchObject({ id: "login" });
    } finally {
      delete process.env.FAKE_PROBE_AUTH;
      delete process.env.FAKE_PROBE_SESSION_ERROR;
    }
  });

  it("returns actionable protocol and startup failures", async () => {
    process.env.FAKE_PROBE_PROTOCOL = "1";
    const protocol = await probeAgent(mkdtempSync(join(tmpdir(), "marshal-probe-protocol-cwd-")), { command: "node" as "npx", args: [fakeAgentPath] });
    delete process.env.FAKE_PROBE_PROTOCOL;
    expect(protocol.status).toBe("failed");
    expect(protocol.error).toContain("ACP protocol mismatch");

    const missing = await probeAgent(mkdtempSync(join(tmpdir(), "marshal-probe-missing-cwd-")), { command: "npx", args: ["/does/not/exist"] });
    expect(missing.status).toBe("failed");
    expect(missing.error).toMatch(/ACP (agent command not found|connection closed)/);
  });
});
