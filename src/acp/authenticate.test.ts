import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { authenticateAgent } from "./authenticate.js";

const FAKE_AGENT = `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, authMethods: fs.existsSync('authenticated') ? [] : [{ id: 'login', name: 'Browser login' }] } });
  else if (msg.method === 'authenticate') { fs.writeFileSync('authenticated', 'fixture-secret'); send({ jsonrpc: '2.0', id: msg.id, result: {} }); }
});
`;

let fakeAgentPath: string;
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "marshal-auth-agent-"));
  fakeAgentPath = join(dir, "agent.cjs");
  writeFileSync(fakeAgentPath, FAKE_AGENT, { mode: 0o755 });
  chmodSync(fakeAgentPath, 0o755);
});

describe("ACP agent-managed authentication", () => {
  it("invokes the advertised method without persisting secrets in Marshal", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "marshal-auth-cwd-"));
    await authenticateAgent(cwd, { command: "node" as "npx", args: [fakeAgentPath] }, "login", undefined, 5000);
    expect(readFileSync(join(cwd, "authenticated"), "utf8")).toBe("fixture-secret");
  });

  it("supports cancellation", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "marshal-auth-cancel-"));
    const controller = new AbortController();
    controller.abort();
    await expect(authenticateAgent(cwd, { command: "node" as "npx", args: [fakeAgentPath] }, "login", controller.signal, 5000)).rejects.toThrow("cancelled");
  });
});
