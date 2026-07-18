import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentLaunchSpec } from "../agents/types.js";

export const AUTHENTICATION_TIMEOUT_MS = 10 * 60 * 1000;

export async function authenticateAgent(cwd: string, launch: AgentLaunchSpec, methodId: string, signal?: AbortSignal, timeoutMs = AUTHENTICATION_TIMEOUT_MS): Promise<void> {
  const child = spawn(launch.command, launch.args, { cwd, env: process.env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  let timer: NodeJS.Timeout | undefined;
  const abort = () => child.kill("SIGTERM");
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await waitForSpawn(child, launch.command, timeoutMs);
    if (signal?.aborted) throw new Error("Authentication was cancelled");
    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
    const connection = acp.client({ name: "marshal" }).connect(stream);
    timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    const initialized = await withTimeout(connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { auth: { agent: true, terminal: false, envVars: false } },
      clientInfo: { name: "marshal", version: "0.0.1" },
    }), timeoutMs) as acp.InitializeResponse;
    if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) throw new Error(`ACP protocol mismatch: agent selected ${initialized.protocolVersion}, Marshal supports ${acp.PROTOCOL_VERSION}`);
    const method = (initialized.authMethods ?? []).find((entry) => entry.id === methodId);
    if (!method) throw new Error("The selected authentication method is no longer advertised by the agent");
    if ("type" in method) throw new Error("Only agent-managed authentication is supported in the browser");
    await withTimeout(connection.agent.request(acp.methods.agent.authenticate, { methodId }), timeoutMs);
    connection.close();
  } finally {
    signal?.removeEventListener("abort", abort);
    if (timer) clearTimeout(timer);
    child.kill("SIGTERM");
  }
}

function waitForSpawn(child: ReturnType<typeof spawn>, command: string, timeoutMs: number): Promise<void> {
  return withTimeout(new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", (error: NodeJS.ErrnoException) => reject(error.code === "ENOENT" ? new Error(`ACP agent command not found: ${command}`) : new Error(`Failed to start ACP agent command "${command}": ${error.message}`))); }), timeoutMs);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`ACP authentication timed out after ${timeoutMs}ms`)), timeoutMs); })]); }
  finally { if (timer) clearTimeout(timer); }
}
