import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentCapabilities, AgentAuthMethod, AgentLaunchSpec } from "../agents/types.js";
import type { ReadinessResult } from "./types.js";

export const PROBE_TIMEOUT_MS = 15_000;

export async function probeAgent(cwd: string, launch: AgentLaunchSpec, timeoutMs = PROBE_TIMEOUT_MS): Promise<ReadinessResult> {
  const child = spawn(launch.command, launch.args, { cwd, env: process.env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  let timer: NodeJS.Timeout | undefined;
  try {
    await waitForSpawn(child, launch.command, timeoutMs);
    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
    const connection = acp.client({ name: "marshal" }).connect(stream);
    timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    const initialized = await withTimeout(connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { auth: { agent: true, terminal: false, envVars: false } },
      clientInfo: { name: "marshal", version: "0.0.1" },
    }), timeoutMs) as acp.InitializeResponse;
    if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
      connection.close();
      throw new Error(`ACP protocol mismatch: agent selected ${initialized.protocolVersion}, Marshal supports ${acp.PROTOCOL_VERSION}`);
    }
    const raw = initialized as unknown as Record<string, unknown>;
    const authMethods = (initialized.authMethods ?? []).map(normalizeAuthMethod);
    const capabilities = normalizeCapabilities(initialized.agentCapabilities);
    if (authMethods.length > 0) {
      connection.close();
      return { status: "authentication_required", protocol_version: initialized.protocolVersion, capabilities, auth_methods: authMethods, raw_initialize: raw, error: "Agent authentication is required before a session can start" };
    }
    const session = await withTimeout(connection.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] }), timeoutMs);
    if (capabilities.session.close) {
      await withTimeout(connection.agent.request(acp.methods.agent.session.close, { sessionId: session.sessionId }), timeoutMs);
    }
    connection.close();
    return { status: "ready", protocol_version: initialized.protocolVersion, capabilities, auth_methods: authMethods, raw_initialize: raw, error: null };
  } catch (error) {
    return { status: "failed", protocol_version: null, capabilities: null, auth_methods: [], raw_initialize: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer) clearTimeout(timer);
    child.kill("SIGTERM");
  }
}

function normalizeCapabilities(value: import("@agentclientprotocol/sdk").AgentCapabilities | undefined): AgentCapabilities {
  return {
    prompt: { text: true, image: value?.promptCapabilities?.image === true, audio: value?.promptCapabilities?.audio === true, embedded_context: value?.promptCapabilities?.embeddedContext === true },
    session: { close: value?.sessionCapabilities?.close != null, list: value?.sessionCapabilities?.list != null, load: value?.loadSession === true, fork: value?.sessionCapabilities?.fork != null, resume: value?.sessionCapabilities?.resume != null },
    load_session: value?.loadSession === true,
    auth: { logout: value?.auth?.logout != null },
  };
}

function normalizeAuthMethod(method: import("@agentclientprotocol/sdk").AuthMethod): AgentAuthMethod {
  return { id: method.id, type: "type" in method && method.type ? method.type : "agent", name: method.name, description: method.description ?? null };
}

function waitForSpawn(child: ReturnType<typeof spawn>, command: string, timeoutMs: number): Promise<void> {
  return withTimeout(new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", (error: NodeJS.ErrnoException) => reject(error.code === "ENOENT" ? new Error(`ACP agent command not found: ${command}`) : new Error(`Failed to start ACP agent command "${command}": ${error.message}`))); }), timeoutMs);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`ACP readiness probe timed out after ${timeoutMs}ms`)), timeoutMs); })]); }
  finally { if (timer) clearTimeout(timer); }
}
