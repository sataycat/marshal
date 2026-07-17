import { ChildProcess, spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, portFilePath, startHttpServer } from "./http.js";
import { loadGlobalConfig } from "../worktree/config.js";

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
    } finally {
      await handle.close();
    }
  });

  it("rejects non-loopback startup without a password", async () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-auth-bind-"));
    await expect(startHttpServer({ root, host: "0.0.0.0", port: 0, version: "0.0.1" })).rejects.toThrow("Refusing non-loopback bind without a UI password");
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

describe("marshal daemon start end-to-end", () => {
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
      [binPath, "daemon", "start", "--port", String(requestedPort), "--interval", "1000"],
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
