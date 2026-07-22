import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { beginAgentAuthentication, createInstallation, finishInstallation, getAgentAuthenticationOperation, interruptActiveAgentAuthentications, setAgentReadiness } from "../agents/store.js";
import type { AgentAuthMethod, InstalledAgent } from "../agents/types.js";
import { TERMINAL_AUTH_MAX_OUTPUT_FRAME_BYTES, TerminalAuthManager } from "./terminal-auth.js";

class FakePty {
  pid = 123;
  process = "fake";
  cols = 100;
  rows = 30;
  handleFlowControl = false;
  private emitter = new EventEmitter();
  writes: string[] = [];
  kills: string[] = [];
  onData(listener: (data: string) => void) { this.emitter.on("data", listener); return { dispose: () => this.emitter.off("data", listener) }; }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void) { this.emitter.on("exit", listener); return { dispose: () => this.emitter.off("exit", listener) }; }
  write(data: string) { this.writes.push(data); }
  resize() {}
  clear() {}
  pause() {}
  resume() {}
  kill(signal?: string) { this.kills.push(signal ?? "SIGHUP"); }
  emitData(data: string) { this.emitter.emit("data", data); }
  emitExit(exitCode: number, signal = 0) { this.emitter.emit("exit", { exitCode, signal }); }
}

class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.emit("close"); }
}

function fixture(machineDir: string): { installed: InstalledAgent; method: AgentAuthMethod; operation: ReturnType<typeof beginAgentAuthentication> } {
  const created = createInstallation({ id: "terminal-agent", version: "1.0.0", source: "registry", license: "MIT", distribution: "binary", package_specifier: "fixture", launch: { command: "/pinned/agent", args: ["serve"], env: { BASE: "launch" } }, registry_snapshot_fetched_at: "fixture", integrity_status: "verified", status: "installing", readiness_status: "authentication_required", readiness_error: "sign in", protocol_version: 1, capabilities: null, auth_methods: [], raw_initialize: null, probed_at: new Date().toISOString(), installation_id: "exact-install", installation_root: machineDir }, "install", machineDir);
  finishInstallation(created.id, "installed", null, machineDir);
  const method: AgentAuthMethod = { id: "terminal-login", type: "terminal", name: "Terminal login", description: null, vars: [], link: null, args: ["auth", "--device"], env: { AUTH_MODE: "terminal" }, meta: null, raw: {} };
  const installed = setAgentReadiness("terminal-agent", "1.0.0", { readiness_status: "authentication_required", readiness_error: "sign in", protocol_version: 1, capabilities: null, auth_methods: [method], raw_initialize: {}, probed_at: new Date().toISOString() }, machineDir, "exact-install");
  const operation = beginAgentAuthentication({ id: "auth-op", agent_id: installed.id, version: installed.version, installation_id: installed.installation_id, method_id: method.id, method_name: method.name, method_type: "terminal" }, machineDir);
  return { installed, method, operation };
}

describe("terminal authentication manager", () => {
  it("spawns the pinned command directly with exact normal plus advertised args/env and no shell", () => {
    const machineDir = mkdtempSync(join(tmpdir(), "marshal-terminal-containment-"));
    const { installed, method, operation } = fixture(machineDir);
    const fake = new FakePty();
    const spawn = vi.fn((..._args: unknown[]) => fake as never);
    const manager = new TerminalAuthManager({ machineDir, spawnPty: spawn as never });
    manager.start(operation, installed, method);
    expect(spawn).toHaveBeenCalledOnce();
    const call = spawn.mock.calls[0] as unknown[];
    expect(call[0]).toBe("/pinned/agent");
    expect(call[1]).toEqual(["serve", "auth", "--device"]);
    expect(call[2]).toMatchObject({ env: expect.objectContaining({ BASE: "launch", AUTH_MODE: "terminal" }) });
    expect(call[2]).not.toHaveProperty("shell");
  });

  it("bounds reconnect output, accepts input, and cancels the PTY", () => {
    const machineDir = mkdtempSync(join(tmpdir(), "marshal-terminal-stream-"));
    const { installed, method, operation } = fixture(machineDir);
    const fake = new FakePty();
    const manager = new TerminalAuthManager({ machineDir, spawnPty: (() => fake) as never, maxOutputBytes: 5 });
    manager.start(operation, installed, method);
    fake.emitData("123456789");
    expect(manager.snapshot(operation.id)).toMatchObject({ output: "56789", output_truncated: true, phase: "running" });
    manager.cancel(operation.id);
    expect(fake.kills).toContain("SIGTERM");
    expect(getAgentAuthenticationOperation(operation.id, machineDir)).toMatchObject({ status: "cancelled", terminal_output_truncated: true });
    expect(manager.snapshot(operation.id)?.output).toBe("56789");
  });

  it("bounds oversized live output frames and delivery while preserving UTF-8 order and truncation", () => {
    const machineDir = mkdtempSync(join(tmpdir(), "marshal-terminal-live-bound-"));
    const { installed, method, operation } = fixture(machineDir);
    const fake = new FakePty();
    const outputLimit = 6000;
    const manager = new TerminalAuthManager({ machineDir, spawnPty: (() => fake) as never, maxOutputBytes: outputLimit });
    manager.start(operation, installed, method);
    const socket = new FakeSocket();
    expect(manager.attach(operation.id, socket as never)).toBe(true);
    socket.sent.length = 0;

    const hostileChunk = `${"prefix".repeat(3000)}${"🙂α".repeat(3000)}`;
    fake.emitData(hostileChunk);

    expect(socket.sent.length).toBeGreaterThan(1);
    expect(socket.sent.every((frame) => Buffer.byteLength(frame) <= TERMINAL_AUTH_MAX_OUTPUT_FRAME_BYTES)).toBe(true);
    const frames = socket.sent.map((frame) => JSON.parse(frame) as { type: string; payload: { data: string; output_truncated: boolean; output_limit_bytes: number } });
    expect(frames.every((frame) => frame.type === "terminal.output" && frame.payload.output_truncated && frame.payload.output_limit_bytes === outputLimit)).toBe(true);
    expect(frames.every((frame) => !frame.payload.data.includes("�"))).toBe(true);
    const delivered = frames.map((frame) => frame.payload.data).join("");
    expect(Buffer.byteLength(delivered)).toBeLessThanOrEqual(outputLimit);
    expect(delivered).toBe(manager.snapshot(operation.id)?.output);
    expect(hostileChunk.endsWith(delivered)).toBe(true);
    expect(manager.snapshot(operation.id)?.output_truncated).toBe(true);
  });

  it("times out idle terminals", async () => {
    const machineDir = mkdtempSync(join(tmpdir(), "marshal-terminal-timeout-"));
    const { installed, method, operation } = fixture(machineDir);
    const fake = new FakePty();
    const manager = new TerminalAuthManager({ machineDir, spawnPty: (() => fake) as never, idleMs: 5, runtimeMs: 1000 });
    manager.start(operation, installed, method);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getAgentAuthenticationOperation(operation.id, machineDir)).toMatchObject({ status: "failed", terminal_diagnostic: { code: "terminal_idle_timeout" } });
  });

  it("only succeeds after a successful fresh reprobe and preserves failed reprobe diagnostics", async () => {
    const machineDir = mkdtempSync(join(tmpdir(), "marshal-terminal-reprobe-"));
    const first = fixture(machineDir); const firstPty = new FakePty();
    const readyActivate = vi.fn(async () => ({ ...first.installed, readiness_status: "ready", readiness_error: null }));
    const readyManager = new TerminalAuthManager({ machineDir, spawnPty: (() => firstPty) as never, activate: readyActivate as never });
    readyManager.start(first.operation, first.installed, first.method); firstPty.emitExit(0);
    await vi.waitFor(() => expect(getAgentAuthenticationOperation(first.operation.id, machineDir)?.status).toBe("succeeded"));

    const second = beginAgentAuthentication({ id: "auth-op-failed", agent_id: first.installed.id, version: first.installed.version, installation_id: first.installed.installation_id, method_id: first.method.id, method_name: first.method.name, method_type: "terminal" }, machineDir);
    const secondPty = new FakePty();
    const failedManager = new TerminalAuthManager({ machineDir, spawnPty: (() => secondPty) as never, activate: (async () => ({ ...first.installed, readiness_status: "authentication_required", readiness_error: "still signed out", readiness_failure: { kind: "authentication_required", message: "still signed out", protocol_code: -32000, data: null } })) as never });
    failedManager.start(second, first.installed, first.method); secondPty.emitExit(0);
    await vi.waitFor(() => expect(getAgentAuthenticationOperation(second.id, machineDir)?.status).toBe("failed"));
    expect(getAgentAuthenticationOperation(second.id, machineDir)).toMatchObject({ error: "still signed out", terminal_diagnostic: { code: "terminal_reprobe_not_ready" }, failure: { kind: "authentication_required" } });
  });

  it("reconciles an in-flight terminal operation on daemon restart without persisting transcript", () => {
    const machineDir = mkdtempSync(join(tmpdir(), "marshal-terminal-restart-"));
    const { operation } = fixture(machineDir);
    interruptActiveAgentAuthentications(machineDir);
    expect(getAgentAuthenticationOperation(operation.id, machineDir)).toMatchObject({ status: "interrupted", terminal_diagnostic: { code: "terminal_daemon_restart" }, failure: { kind: "cancelled" } });
  });
});
