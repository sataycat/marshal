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
      authMethods: process.env.FAKE_PROBE_AUTH === '1' ? [{ id: 'login', name: 'Browser login' }] : [],
    } });
  } else if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'probe-session' } });
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

  it("reports authentication-required agents without creating a session", async () => {
    process.env.FAKE_PROBE_AUTH = "1";
    const result = await probeAgent(mkdtempSync(join(tmpdir(), "marshal-probe-auth-cwd-")), { command: "node" as "npx", args: [fakeAgentPath] });
    delete process.env.FAKE_PROBE_AUTH;
    expect(result.status).toBe("authentication_required");
    expect(result.auth_methods[0]).toMatchObject({ id: "login", type: "agent" });
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
