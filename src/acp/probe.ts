import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentCapabilities, AgentAuthMethod, AgentLaunchSpec } from "../agents/types.js";
import type { ReadinessResult } from "./types.js";
import { isAcpAuthRequired, structuredAcpError } from "./errors.js";
import { MARSHAL_CLIENT_CAPABILITIES } from "./client-capabilities.js";

export const PROBE_TIMEOUT_MS = 15_000;

export async function probeAgent(cwd: string, launch: AgentLaunchSpec, timeoutMs = PROBE_TIMEOUT_MS): Promise<ReadinessResult> {
  const child = spawn(launch.command, launch.args, { cwd, env: { ...process.env, ...launch.env }, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  let timer: NodeJS.Timeout | undefined;
  let protocolVersion: number | null = null;
  let capabilities: AgentCapabilities | null = null;
  let authMethods: AgentAuthMethod[] = [];
  let rawInitialize: Record<string, unknown> | null = null;
  try {
    await waitForSpawn(child, launch.command, timeoutMs);
    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
    const connection = acp.client({ name: "marshal" }).connect(stream);
    timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    const initialized = await withTimeout(connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: MARSHAL_CLIENT_CAPABILITIES,
      clientInfo: { name: "marshal", version: "0.0.1" },
    }), timeoutMs) as acp.InitializeResponse;
    protocolVersion = initialized.protocolVersion;
    rawInitialize = initialized as unknown as Record<string, unknown>;
    authMethods = (initialized.authMethods ?? []).map(normalizeAuthMethod);
    capabilities = normalizeCapabilities(initialized.agentCapabilities);
    if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
      connection.close();
      throw new Error(`ACP protocol mismatch: agent selected ${initialized.protocolVersion}, Marshal supports ${acp.PROTOCOL_VERSION}`);
    }
    const session = await withTimeout(connection.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] }), timeoutMs);
    if (capabilities.session.close) {
      await withTimeout(connection.agent.request(acp.methods.agent.session.close, { sessionId: session.sessionId }), timeoutMs);
    }
    connection.close();
    return { status: "ready", protocol_version: protocolVersion, capabilities, auth_methods: authMethods, raw_initialize: rawInitialize, error: null, failure: null };
  } catch (error) {
    const failure = structuredAcpError(error);
    return { status: isAcpAuthRequired(error) ? "authentication_required" : "failed", protocol_version: protocolVersion, capabilities, auth_methods: authMethods, raw_initialize: rawInitialize, error: failure.message, failure };
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

export function normalizeAuthMethod(method: import("@agentclientprotocol/sdk").AuthMethod): AgentAuthMethod {
  const raw = structuredClone(method) as unknown as Record<string, unknown>;
  const type = "type" in method && typeof method.type === "string" ? method.type : "agent";
  const vars = type === "env_var" && "vars" in method && Array.isArray(method.vars) ? method.vars.map((variable) => ({
    name: variable.name,
    label: variable.label ?? null,
    secret: variable.secret ?? true,
    optional: variable.optional ?? false,
    meta: variable._meta ?? null,
    raw: structuredClone(variable) as Record<string, unknown>,
  })) : [];
  return {
    id: method.id,
    type,
    name: method.name,
    description: method.description ?? null,
    vars,
    link: type === "env_var" && "link" in method ? method.link ?? null : null,
    args: type === "terminal" && "args" in method ? [...(method.args ?? [])] : [],
    env: type === "terminal" && "env" in method ? { ...(method.env ?? {}) } : {},
    meta: method._meta ?? null,
    raw,
  };
}

function waitForSpawn(child: ReturnType<typeof spawn>, command: string, timeoutMs: number): Promise<void> {
  return withTimeout(new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", (error: NodeJS.ErrnoException) => reject(error.code === "ENOENT" ? new Error(`ACP agent command not found: ${command}`) : new Error(`Failed to start ACP agent command "${command}": ${error.message}`))); }), timeoutMs);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`ACP readiness probe timed out after ${timeoutMs}ms`)), timeoutMs); })]); }
  finally { if (timer) clearTimeout(timer); }
}
