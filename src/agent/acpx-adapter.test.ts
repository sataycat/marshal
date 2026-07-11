import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.js";
import { AcpxAgentAdapter } from "./acpx-adapter.js";
import type { AgentEvent, AgentSession } from "./types.js";

const FAKE_ACPX = `#!/usr/bin/env node
const args = process.argv.slice(2);
const fs = require('fs');
const logFile = process.env.FAKE_ACPX_LOG;
function log(...msg) {
  if (logFile) fs.appendFileSync(logFile, msg.join(' ') + '\\n');
}
function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
}
const agent = args[0];
if (args[0] === '--version') {
  console.log(process.env.FAKE_ACPX_VERSION || '0.12.0');
  process.exit(0);
}
if (!agent) {
  console.error('missing agent');
  process.exit(2);
}
if (args.includes('sessions') && args.includes('ensure')) {
  const name = getArg('--name');
  const cwd = getArg('--cwd');
  console.log(JSON.stringify({ recordId: 'rec-' + name, name, cwd, agent }));
  process.exit(0);
}
if (args.includes('sessions') && args.includes('close')) {
  const closeIdx = args.indexOf('close');
  const name = args[closeIdx + 1];
  log('CLOSE', agent, name);
  process.exit(0);
}
if (args.includes('cancel')) {
  log('CANCEL', agent, getArg('-s') || getArg('--name'));
  process.exit(0);
}
if (args.includes('-s') && args.includes('--file')) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { input += d; });
  process.stdin.on('end', () => {
    const stderr = process.env.FAKE_ACPX_STDERR || '';
    for (const line of stderr.split('\\n')) {
      if (line) console.error(line);
    }
    const events = process.env.FAKE_ACPX_EVENTS ? JSON.parse(process.env.FAKE_ACPX_EVENTS) : [];
    for (const ev of events) {
      if (typeof ev === 'string') console.log(ev);
      else console.log(JSON.stringify(ev));
    }
    process.exit(Number(process.env.FAKE_ACPX_EXIT_CODE || 0));
  });
  return;
}
console.error('Unknown acpx command:', args.join(' '));
process.exit(2);
`;

function makeAdapter(options?: { binPath?: string; versionRange?: string }) {
  return new AcpxAgentAdapter(options);
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of events) {
    out.push(ev);
  }
  return out;
}

function sessionFixture(cwd: string): AgentSession {
  return { agentId: "opencode", cwd, name: "marshal-opencode", recordId: "rec-marshal-opencode" };
}

describe("AcpxAgentAdapter", () => {
  let fakeBinPath: string;

  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "marshal-agent-"));
    fakeBinPath = join(dir, "acpx.cjs");
    writeFileSync(fakeBinPath, FAKE_ACPX, { mode: 0o755 });
    chmodSync(fakeBinPath, 0o755);
  });

  afterEach(() => {
    delete process.env.FAKE_ACPX_EVENTS;
    delete process.env.FAKE_ACPX_STDERR;
    delete process.env.FAKE_ACPX_EXIT_CODE;
    delete process.env.FAKE_ACPX_VERSION;
    delete process.env.FAKE_ACPX_LOG;
  });

  it("spawns a session by ensuring an ACPX session", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "marshal-cwd-"));
    const adapter = makeAdapter({ binPath: fakeBinPath, versionRange: ">=0.12.0 <0.13.0" });

    const session = await adapter.spawn(cwd, "opencode");

    expect(session.agentId).toBe("opencode");
    expect(session.cwd).toBe(cwd);
    expect(session.name).toBe("marshal-opencode");
    expect(session.recordId).toMatch(/^rec-marshal-opencode/);
  });

  it("uses a custom session name when provided", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "marshal-cwd-"));
    const adapter = makeAdapter({ binPath: fakeBinPath, versionRange: ">=0.12.0 <0.13.0" });

    const session = await adapter.spawn(cwd, "pi", { sessionName: "custom-name" });

    expect(session.name).toBe("custom-name");
    expect(session.recordId).toBe("rec-custom-name");
  });

  it("streams text chunks and a done event from a prompt", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "marshal-cwd-"));
    const adapter = makeAdapter({ binPath: fakeBinPath, versionRange: ">=0.12.0 <0.13.0" });
    const session = sessionFixture(cwd);

    process.env.FAKE_ACPX_EVENTS = JSON.stringify([
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello, " },
        },
      },
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world!" } },
      },
      { jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } },
    ]);

    const events = await collect(adapter.prompt(session, "say hi"));

    expect(events).toEqual([
      { type: "text", text: "Hello, " },
      { type: "text", text: "world!" },
      { type: "done", stopReason: "end_turn" },
    ]);
  });

  it("maps stderr lines to log events", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "marshal-cwd-"));
    const adapter = makeAdapter({ binPath: fakeBinPath, versionRange: ">=0.12.0 <0.13.0" });
    const session = sessionFixture(cwd);

    process.env.FAKE_ACPX_EVENTS = JSON.stringify([
      { jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } },
    ]);
    process.env.FAKE_ACPX_STDERR = "warning one\nwarning two";

    const events = await collect(adapter.prompt(session, "x"));

    const logs = events.filter((e) => e.type === "log");
    expect(logs).toEqual([
      { type: "log", stream: "stderr", text: "warning one" },
      { type: "log", stream: "stderr", text: "warning two" },
    ]);
  });

  it("emits a timeout done and error event for ACPX exit code 3", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "marshal-cwd-"));
    const adapter = makeAdapter({ binPath: fakeBinPath, versionRange: ">=0.12.0 <0.13.0" });
    const session = sessionFixture(cwd);

    process.env.FAKE_ACPX_EXIT_CODE = "3";

    const events = await collect(adapter.prompt(session, "x"));

    expect(events).toEqual([
      { type: "done", stopReason: "timeout" },
      { type: "error", message: "timeout", code: 3 },
    ]);
  });

  it("emits an error event for other non-zero exit codes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "marshal-cwd-"));
    const adapter = makeAdapter({ binPath: fakeBinPath, versionRange: ">=0.12.0 <0.13.0" });
    const session = sessionFixture(cwd);

    process.env.FAKE_ACPX_EXIT_CODE = "1";

    const events = await collect(adapter.prompt(session, "x"));

    expect(events).toEqual([{ type: "error", message: "agent error", code: 1 }]);
  });

  it("cancels a session by invoking acpx cancel", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "marshal-cwd-"));
    const logFile = join(tmpdir(), "cancel.log");
    process.env.FAKE_ACPX_LOG = logFile;
    const adapter = makeAdapter({ binPath: fakeBinPath, versionRange: ">=0.12.0 <0.13.0" });
    const session = sessionFixture(cwd);

    await adapter.cancel(session);

    expect(readFileSync(logFile, "utf8")).toContain("CANCEL opencode marshal-opencode");
  });

  it("closes a session by invoking acpx sessions close", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "marshal-cwd-"));
    const logFile = join(tmpdir(), "close.log");
    process.env.FAKE_ACPX_LOG = logFile;
    const adapter = makeAdapter({ binPath: fakeBinPath, versionRange: ">=0.12.0 <0.13.0" });
    const session = sessionFixture(cwd);

    await adapter.close(session);

    expect(readFileSync(logFile, "utf8")).toContain("CLOSE opencode marshal-opencode");
  });

  it("throws a clear error when acpx is not installed", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "marshal-cwd-"));
    const adapter = makeAdapter({ binPath: "/does/not/exist/acpx" });

    await expect(adapter.spawn(cwd, "opencode")).rejects.toThrow(
      "acpx is not installed. Install with `npm i -g acpx@latest`",
    );
  });

  it("passes a custom agent id straight through to acpx (ADR-019)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "marshal-cwd-"));
    const adapter = makeAdapter({ binPath: fakeBinPath, versionRange: ">=0.12.0 <0.13.0" });

    const session = await adapter.spawn(cwd, "claude-code");

    expect(session.agentId).toBe("claude-code");
    expect(session.name).toBe("marshal-claude-code");
    expect(session.recordId).toMatch(/^rec-marshal-claude-code/);
  });

  it("warns when the installed ACPX version is outside the expected range", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "marshal-cwd-"));
    process.env.FAKE_ACPX_VERSION = "0.11.0";
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    const adapter = makeAdapter({ binPath: fakeBinPath, versionRange: ">=0.12.0 <0.13.0" });

    await adapter.spawn(cwd, "opencode");

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ version: "0.11.0", expected: ">=0.12.0 <0.13.0" }),
      "ACPX version does not match the expected range",
    );

    warnSpy.mockRestore();
  });
});
