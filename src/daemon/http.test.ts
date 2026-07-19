import { ChildProcess, spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, portFilePath, startHttpServer } from "./http.js";
import { loadGlobalConfig } from "../worktree/config.js";
import { EventBus } from "./bus.js";
import { createInstallation, finishInstallation, getInstallationOperation, updateInstallationPhase } from "../agents/store.js";
import { completeRegistryRefresh, beginRegistryRefresh } from "../registry/store.js";

function fetchJson(url: string): Promise<{ status: number; body: unknown }> {
  return fetch(url).then(async (res) => ({ status: res.status, body: await res.json() }));
}

describe("buildApp /api/health", () => {
  it("returns ok with the daemon version", async () => {
    const app = buildApp("0.0.1");
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", version: "0.0.1" });
  });

  it("returns 404 for unknown routes", async () => {
    const app = buildApp("0.0.1");
    const res = await app.request("/api/nope");
    expect(res.status).toBe(404);
  });

  it("serves the cached registry catalog and searches validated fields", async () => {
    const machineDir = mkdtempSync(join(tmpdir(), "marshal-registry-http-"));
    const { beginRegistryRefresh, completeRegistryRefresh } = await import("../registry/store.js");
    const refresh = beginRegistryRefresh(machineDir);
    completeRegistryRefresh(refresh.id, { version: "1.0.0", source: "fixture://registry", fetched_at: new Date().toISOString(), agents: [{ id: "demo", name: "Demo Agent", version: "1.0.0", description: "Searchable coding helper", license: "MIT", authors: [], distributions: [{ kind: "npx", package: "demo@1.0.0" }] }] }, machineDir);
    const app = buildApp("0.0.1", { machineDir });
    const res = await app.request("/api/registry/agents?q=searchable");
    expect(res.status).toBe(200);
    const body = await res.json() as { agents: unknown[] };
    expect(body.agents).toHaveLength(1);
  });
});

describe("installation operation API durability", () => {
  it("retries a failed durable operation using the cached registry version", async () => {
    const machineDir = mkdtempSync(join(tmpdir(), "marshal-install-retry-")); const refresh = beginRegistryRefresh(machineDir);
    completeRegistryRefresh(refresh.id, { version: "1.0.0", source: "fixture", fetched_at: "fixture", agents: [{ id: "retry-agent", name: "Retry", version: "1.0.0", description: "fixture", license: "MIT", authors: [], distributions: [{ kind: "npx", package: "retry-agent@1.0.0" }] }] }, machineDir);
    const operation = createInstallation({ id: "retry-agent", version: "1.0.0", source: "registry", license: "MIT", distribution: "npx", package_specifier: "retry-agent@1.0.0", launch: { command: "npx", args: ["retry-agent@1.0.0"] }, registry_snapshot_fetched_at: "fixture", integrity_status: "not_applicable", status: "installing", readiness_status: "unknown", readiness_error: null, protocol_version: null, capabilities: null, auth_methods: [], raw_initialize: null, probed_at: null }, "retry-op", machineDir);
    finishInstallation(operation.id, "failed", "failed", machineDir, { code: "installation_failed", diagnostic: { message: "failed", action: "Retry" } });
    const app = buildApp("0.0.1", { machineDir });
    const response = await app.request(`/api/agents/operations/${operation.id}/retry`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(response.status).toBe(202);
    expect((await response.json() as { operation: { agent_id: string; status: string } }).operation).toMatchObject({ agent_id: "retry-agent", status: "installing" });
  });

  it("cancels an installation through the durable API", async () => {
    const machineDir = mkdtempSync(join(tmpdir(), "marshal-install-cancel-api-"));
    const operation = createInstallation({ id: "cancel-agent", version: "1.0.0", source: "registry", license: "MIT", distribution: "npx", package_specifier: "cancel-agent@1.0.0", launch: { command: "npx", args: ["cancel-agent@1.0.0"] }, registry_snapshot_fetched_at: "fixture", integrity_status: "not_applicable", status: "installing", readiness_status: "unknown", readiness_error: null, protocol_version: null, capabilities: null, auth_methods: [], raw_initialize: null, probed_at: null }, "cancel-op", machineDir);
    const app = buildApp("0.0.1", { machineDir }); const response = await app.request(`/api/agents/operations/${operation.id}/cancel`, { method: "POST" });
    expect(response.status).toBe(200); expect((await response.json() as { operation: { status: string; error_code: string } }).operation).toMatchObject({ status: "interrupted", error_code: "installation_cancelled" });
  });
  it("hydrates progress and terminal diagnostics from durable storage", async () => {
    const machineDir = mkdtempSync(join(tmpdir(), "marshal-install-api-"));
    const operation = createInstallation({ id: "demo", version: "1.0.0", source: "registry", license: "MIT", distribution: "npx", package_specifier: "demo@1.0.0", launch: { command: "npx", args: ["demo@1.0.0"] }, registry_snapshot_fetched_at: "fixture", integrity_status: "not_applicable", status: "installing", readiness_status: "unknown", readiness_error: null, protocol_version: null, capabilities: null, auth_methods: [], raw_initialize: null, probed_at: null }, "op-api", machineDir);
    updateInstallationPhase(operation.id, "downloading", {}, machineDir);
    const app = buildApp("0.0.1", { machineDir, bus: new EventBus() });
    expect((await app.request(`/api/agents/operations/${operation.id}`)).status).toBe(200);
    expect((await (await app.request(`/api/agents/operations/${operation.id}`)).json() as { operation: { phase: string } }).operation.phase).toBe("downloading");
    finishInstallation(operation.id, "failed", "download timed out", machineDir, { code: "download_timeout", diagnostic: { message: "download timed out", action: "Retry the installation." } });
    const hydrated = (await (await app.request(`/api/agents/operations/${operation.id}`)).json() as { operation: ReturnType<typeof getInstallationOperation> }).operation!;
    expect(hydrated).toMatchObject({ phase: "failed", status: "failed", error_code: "download_timeout", diagnostic: { action: "Retry the installation." } });
  });

  it("recovers an interrupted operation from durable storage across a new app instance", async () => {
    const machineDir = mkdtempSync(join(tmpdir(), "marshal-install-restart-"));
    const operation = createInstallation({ id: "restart-agent", version: "1.0.0", source: "registry", license: "MIT", distribution: "npx", package_specifier: "restart-agent@1.0.0", launch: { command: "npx", args: ["restart-agent@1.0.0"] }, registry_snapshot_fetched_at: "fixture", integrity_status: "not_applicable", status: "installing", readiness_status: "unknown", readiness_error: null, protocol_version: null, capabilities: null, auth_methods: [], raw_initialize: null, probed_at: null }, "restart-op", machineDir, { temporary_root: join(machineDir, "agents", ".tmp-restart"), published_root: join(machineDir, "agents", "restart-agent", "1.0.0", "published") });
    const first = buildApp("0.0.1", { machineDir });
    expect((await first.request(`/api/agents/operations/${operation.id}`)).status).toBe(200);
    const { reconcileInstallationOperations } = await import("../agents/store.js"); reconcileInstallationOperations(machineDir);
    const afterRestart = buildApp("0.0.1", { machineDir });
    expect((await (await afterRestart.request(`/api/agents/operations/${operation.id}`)).json() as { operation: { status: string; phase: string } }).operation).toMatchObject({ status: "interrupted", phase: "interrupted" });
  });
});

describe("authenticated HTTP server", () => {
  it("protects API routes and supports login/logout", async () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-auth-"));
    const handle = await startHttpServer({ root, host: "127.0.0.1", port: 0, version: "0.0.1", uiPassword: "secret" });
    try {
      const base = `http://127.0.0.1:${handle.port}`;
      expect((await fetch(`${base}/api/tasks`)).status).toBe(401);
      const login = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "secret" }),
      });
      expect(login.status).toBe(200);
      const cookie = login.headers.get("set-cookie");
      expect(cookie).toContain("HttpOnly");
      expect((await fetch(`${base}/api/tasks`, { headers: { Cookie: cookie?.split(";")[0] ?? "" } })).status).toBe(200);
      const logout = await fetch(`${base}/api/auth/logout`, {
        method: "POST",
        headers: { Cookie: cookie?.split(";")[0] ?? "" },
      });
      expect(logout.status).toBe(200);
      expect((await fetch(`${base}/api/tasks`, { headers: { Cookie: cookie?.split(";")[0] ?? "" } })).status).toBe(401);
    } finally {
      await handle.close();
    }
  });

  it("rate-limits failed passwords per direct client and honors secure proxy cookies", async () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-auth-rate-"));
    const handle = await startHttpServer({ root, host: "127.0.0.1", port: 0, version: "0.0.1", uiPassword: "secret", trustedProxy: true });
    try {
      const base = `http://127.0.0.1:${handle.port}`;
      for (let i = 0; i < 5; i += 1) {
        await fetch(`${base}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Forwarded-For": "192.0.2.10" },
          body: JSON.stringify({ password: "wrong" }),
        });
      }
      const locked = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": "192.0.2.10" },
        body: JSON.stringify({ password: "secret" }),
      });
      expect(locked.status).toBe(429);

      const login = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": "192.0.2.11", "X-Forwarded-Proto": "https" },
        body: JSON.stringify({ password: "secret" }),
      });
      expect(login.status).toBe(200);
      expect(login.headers.get("set-cookie")).toContain("Secure");
      const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
      const logout = await fetch(`${base}/api/auth/logout`, {
        method: "POST",
        headers: { Cookie: cookie, "X-Forwarded-Proto": "https" },
      });
      expect(logout.headers.get("set-cookie")).toContain("Secure");
    } finally {
      await handle.close();
    }
  });

  it("rejects non-loopback startup without a password", async () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-auth-bind-"));
    await expect(startHttpServer({ root, host: "0.0.0.0", port: 0, version: "0.0.1" })).rejects.toThrow("LAN access requires a UI password");
  });
});

describe("startHttpServer", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "marshal-http-"));
  });

  afterEach(() => {
    delete process.env.MARSHAL_GLOBAL_CONFIG;
  });

  it("serves /api/health over a bound port and writes daemon.port", async () => {
    const handle = await startHttpServer({
      root,
      host: "127.0.0.1",
      port: 0,
      version: "0.0.1",
      config: loadGlobalConfig(),
    });

    try {
      expect(existsSync(handle.portFile)).toBe(true);
      expect(readFileSync(handle.portFile, "utf8")).toBe(String(handle.port));

      const { status, body } = await fetchJson(`http://127.0.0.1:${handle.port}/api/health`);
      expect(status).toBe(200);
      expect(body).toEqual({ status: "ok", version: "0.0.1" });
    } finally {
      await handle.close();
    }

    expect(existsSync(handle.portFile)).toBe(false);
  });

  it("honours an explicitly requested port", async () => {
    const probe = await startHttpServer({ root, host: "127.0.0.1", port: 0, version: "0.0.1" });
    const requestedPort = probe.port;
    await probe.close();

    const handle = await startHttpServer({
      root,
      host: "127.0.0.1",
      port: requestedPort,
      version: "0.0.1",
    });
    try {
      expect(handle.port).toBe(requestedPort);
      const { status } = await fetchJson(`http://127.0.0.1:${handle.port}/api/health`);
      expect(status).toBe(200);
    } finally {
      await handle.close();
    }
  });

  it("binds to localhost by default when neither flags nor config specify a host", async () => {
    const handle = await startHttpServer({ root, port: 0, version: "0.0.1" });
    try {
      expect(handle.host).toBe("127.0.0.1");
      const { status } = await fetchJson(`http://127.0.0.1:${handle.port}/api/health`);
      expect(status).toBe(200);
    } finally {
      await handle.close();
    }
  });

  it("overwrites a stale port file on a fresh start", async () => {
    mkdirSync(join(root, ".marshal"), { recursive: true });
    writeFileSync(portFilePath(root), "99999");
    const handle = await startHttpServer({ root, port: 0, version: "0.0.1" });
    try {
      expect(existsSync(handle.portFile)).toBe(true);
      expect(readFileSync(handle.portFile, "utf8")).toBe(String(handle.port));
      expect(handle.port).not.toBe(99999);
    } finally {
      await handle.close();
    }
  });

  it("accepts daemon.port from global config when no flag is passed", async () => {
    const probe = await startHttpServer({ root, host: "127.0.0.1", port: 0, version: "0.0.1" });
    const requestedPort = probe.port;
    await probe.close();

    const configPath = join(root, "global-config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ daemon: { port: requestedPort, host: "127.0.0.1" } }),
    );
    process.env.MARSHAL_GLOBAL_CONFIG = configPath;

    const handle = await startHttpServer({ root, version: "0.0.1", config: loadGlobalConfig() });
    try {
      expect(handle.port).toBe(requestedPort);
    } finally {
      await handle.close();
    }
  });

  it("close without a port file does not throw", async () => {
    const handle = await startHttpServer({ root, port: 0, version: "0.0.1" });
    await handle.close();
    if (existsSync(handle.portFile)) unlinkSync(handle.portFile);
    await expect(handle.close()).resolves.toBeUndefined();
    expect(existsSync(handle.portFile)).toBe(false);
  });

  it("rejects an unavailable port with a thrown error and leaves no port file", async () => {
    await expect(
      startHttpServer({ root, host: "127.0.0.1", port: 1, version: "0.0.1" }),
    ).rejects.toThrow();
    expect(existsSync(portFilePath(root))).toBe(false);
  });
});

describe("marshal start end-to-end", () => {
  it("serves /api/health on the discovered port and removes daemon.port on SIGTERM", async () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-cli-http-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, "README.md"), "# test\n");
    execFileSync("git", ["add", "README.md"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: root, stdio: "ignore" });

    const binPath = resolve(process.cwd(), "bin/marshal");
    execFileSync("node", [binPath, "init"], { cwd: root, stdio: "ignore" });

    // Reserve a free port by binding an ephemeral server then closing it.
    const probe = await startHttpServer({ root, host: "127.0.0.1", port: 0, version: "0.0.1" });
    const requestedPort = probe.port;
    await probe.close();

    const daemon = spawn(
      "node",
      [
        binPath,
        "start",
        "--lan",
        "--password",
        "test-password",
        "--port",
        String(requestedPort),
        "--interval",
        "1000",
      ],
      { cwd: root, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, LOG_LEVEL: "error" } },
    );

    let stderrBuf = "";
    daemon.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    let firstError: unknown;
    try {
      await waitForPortFile(root, 5000);
      const port = readFileSync(portFilePath(root), "utf8").trim();
      expect(Number(port)).toBe(requestedPort);

      const { status, body } = await fetchJson(`http://127.0.0.1:${port}/api/health`);
      expect(status).toBe(200);
      expect(body).toEqual({ status: "ok", version: "0.0.1" });
    } catch (err) {
      firstError = err;
    } finally {
      const exited = new Promise<void>((resolveExit) => {
        daemon.on("exit", () => resolveExit());
      });
      daemon.kill("SIGTERM");
      await exited;
      await new Promise((r) => setTimeout(r, 100));
    }

    if (existsSync(portFilePath(root))) {
      throw new Error(`daemon.port not removed on shutdown. stderr:\n${stderrBuf}`);
    }
    if (firstError !== undefined) {
      throw firstError as Error;
    }
    expect(existsSync(portFilePath(root))).toBe(false);
  }, 15000);
});

async function waitForPortFile(root: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(portFilePath(root))) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`daemon.port not written under ${root} within ${timeoutMs}ms`);
}
