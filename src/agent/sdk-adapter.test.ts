import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { SdkAcpAgentAdapter } from "./sdk-adapter.js";
import type { AgentEvent } from "./types.js";

const FAKE_AGENT = `#!/usr/bin/env node
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
let sessionId = 'sdk-session-1';
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
function notify(update) {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
}
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: msg.params.protocolVersion,
      agentCapabilities: { sessionCapabilities: { close: {} } },
    } });
  } else if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId } });
  } else if (msg.method === 'session/prompt') {
    global.pendingPromptId = msg.id;
    if (process.env.FAKE_ACP_HANG === '1') return;
    notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } });
    notify({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
    notify({
      sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Read file',
      kind: 'read', status: 'pending', rawInput: { path: 'README.md' },
    });
    send({
      jsonrpc: '2.0', id: 99, method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: { toolCallId: 'tool-1', title: 'Read file', kind: 'read', status: 'pending' },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      },
    });
  } else if (msg.id === 99) {
    const selected = msg.result.outcome.optionId;
    notify({
      sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', title: 'Read file',
      status: selected === 'allow' ? 'completed' : 'failed', rawOutput: selected,
    });
    send({ jsonrpc: '2.0', id: global.pendingPromptId, result: { stopReason: 'end_turn' } });
  } else if (msg.method === 'session/cancel') {
    if (global.pendingPromptId) {
      send({ jsonrpc: '2.0', id: global.pendingPromptId, result: { stopReason: 'cancelled' } });
      global.pendingPromptId = null;
    }
  } else if (msg.method === 'session/close') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
});
`;

let fakeAgentPath: string;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "marshal-sdk-agent-"));
  fakeAgentPath = join(dir, "agent.cjs");
  writeFileSync(fakeAgentPath, FAKE_AGENT, { mode: 0o755 });
  chmodSync(fakeAgentPath, 0o755);
});

afterEach(() => {
  delete process.env.FAKE_ACP_HANG;
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function makeAdapter(env?: Record<string, string>): SdkAcpAgentAdapter {
  return new SdkAcpAgentAdapter({
    commands: [{ id: "fake", command: fakeAgentPath, args: [], env }],
  });
}

describe("SdkAcpAgentAdapter", () => {
  it("initializes and creates a direct ACP session", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "marshal-sdk-cwd-"));
    const adapter = makeAdapter();
    const session = await adapter.spawn(cwd, "fake", { sessionName: "custom" });

    expect(session).toMatchObject({
      agentId: "fake",
      cwd,
      name: "custom",
      recordId: "sdk-session-1",
    });

    await adapter.close(session);
  });

  it("streams messages, thoughts, tools, permissions, and completion", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "marshal-sdk-cwd-"));
    const adapter = makeAdapter();
    const session = await adapter.spawn(cwd, "fake", { permissionMode: "approve-all" });

    const events = await collect(
      adapter.prompt(session, "hello", { permissionMode: "approve-all" }),
    );

    expect(events).toEqual([
      { type: "text", text: "hello" },
      { type: "thinking", text: "thinking" },
      { type: "tool", title: "Read file", status: "pending" },
      { type: "permission", tool: "Read file", granted: true },
      { type: "tool", title: "Read file", status: "completed", output: "allow" },
      { type: "done", stopReason: "end_turn" },
    ]);

    await adapter.close(session);
  });

  it("applies approve-reads and deny-all by permission option kind", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "marshal-sdk-cwd-"));
    const readsAdapter = makeAdapter();
    const readsSession = await readsAdapter.spawn(cwd, "fake", { permissionMode: "approve-reads" });
    const readsEvents = await collect(
      readsAdapter.prompt(readsSession, "hello", { permissionMode: "approve-reads" }),
    );
    expect(readsEvents).toContainEqual({ type: "permission", tool: "Read file", granted: true });
    await readsAdapter.close(readsSession);

    const denyAdapter = makeAdapter();
    const denySession = await denyAdapter.spawn(cwd, "fake", { permissionMode: "deny-all" });
    const denyEvents = await collect(
      denyAdapter.prompt(denySession, "hello", { permissionMode: "deny-all" }),
    );
    expect(denyEvents).toContainEqual({ type: "permission", tool: "Read file", granted: false });
    expect(denyEvents).toContainEqual({
      type: "tool",
      title: "Read file",
      status: "failed",
      output: "reject",
    });
    await denyAdapter.close(denySession);
  });

  it("waits for an interactive decision and forwards the chosen ACP option ID", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "marshal-sdk-cwd-"));
    const adapter = makeAdapter();
    const session = await adapter.spawn(cwd, "fake", {
      permissionMode: "interactive",
      onPermission: async (request) => {
        expect(request.options.map((option) => option.kind)).toEqual(["allow_once", "reject_once"]);
        expect(request.options[0].optionId).toBe("allow");
        return "allow";
      },
    });
    const events = await collect(adapter.prompt(session, "hello", { permissionMode: "interactive" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "permission", granted: false, requestId: "sdk-session-1:1" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool", status: "completed", output: "allow" }));
    await adapter.close(session);
  });

  it("cancels an active prompt", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "marshal-sdk-cwd-"));
    const adapter = makeAdapter({ FAKE_ACP_HANG: "1" });
    const session = await adapter.spawn(cwd, "fake");

    const eventsPromise = collect(adapter.prompt(session, "wait"));
    await new Promise((resolve) => setTimeout(resolve, 25));
    await adapter.cancel(session);

    await expect(eventsPromise).resolves.toContainEqual({ type: "done", stopReason: "cancelled" });
    await adapter.close(session);
  });

  it("emits deterministic timeout events", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "marshal-sdk-cwd-"));
    const adapter = makeAdapter({ FAKE_ACP_HANG: "1" });
    const session = await adapter.spawn(cwd, "fake");

    const events = await collect(adapter.prompt(session, "wait", { timeoutSeconds: 0.01 }));

    expect(events).toEqual([
      { type: "done", stopReason: "timeout" },
      { type: "error", message: "timeout", code: 3 },
    ]);
    await adapter.close(session);
  });

  it("reports a missing executable clearly", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "marshal-sdk-cwd-"));
    const adapter = new SdkAcpAgentAdapter({
      commands: [{ id: "missing", command: "/does/not/exist/acp-agent", args: [] }],
    });

    await expect(adapter.spawn(cwd, "missing")).rejects.toThrow(
      "ACP agent command not found: /does/not/exist/acp-agent",
    );
  });
});
