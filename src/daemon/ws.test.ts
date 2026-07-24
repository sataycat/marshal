import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startHttpServer } from "./http.js";
import {
  createInstallation,
  finishInstallation,
  setAgentReadiness,
  updateInstallationPhase,
  getInstallationOperation,
} from "../agents/store.js";

function initGitRepo(root: string): void {
  execSync("git init -b main", { cwd: root, stdio: "ignore" });
  execSync("git config user.email test@example.com", { cwd: root, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: root, stdio: "ignore" });
  writeFileSync(join(root, "README.md"), "# Test\n");
  execSync("git add README.md", { cwd: root, stdio: "ignore" });
  execSync("git commit -m init", { cwd: root, stdio: "ignore" });
}

interface MessageCollector {
  next(timeoutMs?: number): Promise<any>;
  close(): void;
}

function collectMessages(ws: WebSocket): MessageCollector {
  const queue: any[] = [];
  const waiters: Array<(msg: any) => void> = [];
  const listener = (data: import("ws").RawData): void => {
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      msg = { raw: data.toString() };
    }
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else queue.push(msg);
  };
  ws.on("message", listener);
  return {
    next(timeoutMs = 2000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("timeout waiting for WS message")),
          timeoutMs,
        );
        const deliver = (msg: any): void => {
          clearTimeout(timer);
          resolve(msg);
        };
        const buffered = queue.shift();
        if (buffered !== undefined) deliver(buffered);
        else waiters.push(deliver);
      });
    },
    close() {
      ws.off("message", listener);
    },
  };
}

async function openSocket(
  url: string,
  options?: { headers?: Record<string, string> },
): Promise<{ ws: WebSocket; collector: MessageCollector }> {
  const ws = new WebSocket(url, options);
  const collector = collectMessages(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (err) => reject(err));
  });
  return { ws, collector };
}

describe("WebSocket event bus", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "marshal-ws-"));
    initGitRepo(repoRoot);
  });

  afterEach(() => {
    delete process.env.MARSHAL_GLOBAL_CONFIG;
  });

  it("acceptance: connect to /ws, create a task via HTTP, observe task.created on the socket", async () => {
    const handle = await startHttpServer({
      root: repoRoot,
      host: "127.0.0.1",
      port: 0,
      version: "0.0.1",
    });

    const { ws, collector } = await openSocket(`ws://127.0.0.1:${handle.port}/ws`);
    try {
      const connected = await collector.next(2000);
      expect(connected.type).toBe("connected");
       expect(connected.payload).toMatchObject({ tasks: [], threads: [] });
      expect(connected.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);

      const res = await fetch(`http://127.0.0.1:${handle.port}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Slice Three Acceptance" }),
      });
      expect(res.status).toBe(201);
      const created = (await res.json()) as { task: { slug: string } };
      const slug = created.task.slug;

      const createdEvent = await collector.next(2000);
      expect(createdEvent.type).toBe("task.created");
      expect(createdEvent.payload).toMatchObject({
        slug,
        title: "Slice Three Acceptance",
        status: "backlog",
      });
    } finally {
      collector.close();
      ws.close();
      await handle.close();
    }
  });

  it("accepts the development web origin for proxied WebSocket connections", async () => {
    const handle = await startHttpServer({
      root: repoRoot,
      host: "127.0.0.1",
      port: 0,
      version: "0.0.1",
      webUrl: "http://localhost:5173",
    });

    const { ws, collector } = await openSocket(`ws://127.0.0.1:${handle.port}/ws`, {
      headers: { Origin: "http://localhost:5173" },
    });
    try {
      expect((await collector.next(2000)).type).toBe("connected");
    } finally {
      collector.close();
      ws.close();
      await handle.close();
    }
  });

  it("broadcasts installation progress and terminal updates, and reconnect hydrates via HTTP", async () => {
    const machineDir = mkdtempSync(join(tmpdir(), "marshal-ws-install-"));
    const operation = createInstallation(
      {
        id: "demo",
        version: "1.0.0",
        source: "registry",
        license: "MIT",
        distribution: "npx",
        package_specifier: "demo@1.0.0",
        launch: { command: "npx", args: ["demo@1.0.0"] },
        registry_snapshot_fetched_at: "fixture",
        integrity_status: "not_applicable",
        status: "installing",
        readiness_status: "unknown",
        readiness_error: null,
        protocol_version: null,
        capabilities: null,
        auth_methods: [],
        raw_initialize: null,
        probed_at: null,
      },
      "op-ws",
      machineDir,
    );
    const handle = await startHttpServer({
      root: repoRoot,
      machineDir,
      host: "127.0.0.1",
      port: 0,
      version: "0.0.1",
    });
    const first = await openSocket(`ws://127.0.0.1:${handle.port}/ws`);
    try {
      await first.collector.next();
      updateInstallationPhase(operation.id, "downloading", {}, machineDir);
      handle.bus.publish("installation.operation.updated", {
        operation: getInstallationOperation(operation.id, machineDir),
      });
      expect((await first.collector.next()).payload.operation).toMatchObject({
        id: operation.id,
        phase: "downloading",
      });
      finishInstallation(operation.id, "failed", "timed out", machineDir, {
        code: "download_timeout",
        diagnostic: { message: "timed out", action: "Retry" },
      });
      handle.bus.publish("installation.operation.updated", {
        operation: getInstallationOperation(operation.id, machineDir),
      });
      expect((await first.collector.next()).payload.operation).toMatchObject({
        phase: "failed",
        error_code: "download_timeout",
      });
      first.collector.close();
      first.ws.close();
      const second = await openSocket(`ws://127.0.0.1:${handle.port}/ws`);
      try {
        await second.collector.next();
        const recovered = await fetch(
          `http://127.0.0.1:${handle.port}/api/agents/operations/${operation.id}`,
        );
        expect(((await recovered.json()) as { operation: { phase: string } }).operation.phase).toBe(
          "failed",
        );
      } finally {
        second.collector.close();
        second.ws.close();
      }
    } finally {
      first.collector.close();
      first.ws.close();
      await handle.close();
    }
  });

  it("sends repository threads in the connected snapshot and broadcasts thread mutations", async () => {
    const machineDir = mkdtempSync(join(tmpdir(), "marshal-ws-machine-"));
    const agent = createInstallation(
      {
        id: "agent-a",
        version: "1.0.0",
        source: "registry",
        license: "MIT",
        distribution: "npx",
        package_specifier: "agent-a@1.0.0",
        launch: { command: "npx", args: ["--yes", "agent-a@1.0.0"] },
        registry_snapshot_fetched_at: "fixture",
        integrity_status: "not_applicable",
        status: "installing",
        readiness_status: "unknown",
        readiness_error: null,
        protocol_version: null,
        capabilities: null,
        auth_methods: [],
        raw_initialize: null,
        probed_at: null,
      },
      "install-op",
      machineDir,
    );
    finishInstallation(agent.id, "installed", null, machineDir);
    setAgentReadiness(
      "agent-a",
      "1.0.0",
      {
        readiness_status: "ready",
        readiness_error: null,
        protocol_version: 1,
        capabilities: {
          prompt: { text: true, image: false, audio: false, embedded_context: false },
          session: { close: true, list: false, load: false, fork: false, resume: false },
          load_session: false,
          auth: { logout: false },
        },
        auth_methods: [],
        raw_initialize: {},
        probed_at: new Date().toISOString(),
      },
      machineDir,
    );
    const handle = await startHttpServer({
      root: repoRoot,
      machineDir,
      host: "127.0.0.1",
      port: 0,
      version: "0.0.1",
    });
    const { ws, collector } = await openSocket(`ws://127.0.0.1:${handle.port}/ws`);
    try {
      const connected = await collector.next();
      expect(connected.payload).toMatchObject({ tasks: [], threads: [] });
      const created = await fetch(`http://127.0.0.1:${handle.port}/api/threads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: "agent-a", agent_version: "1.0.0" }),
      });
      const thread = ((await created.json()) as { thread: { id: string } }).thread;
      expect((await collector.next()).type).toBe("thread.created");
      await fetch(`http://127.0.0.1:${handle.port}/api/threads/${thread.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "user", content: "hello" }),
      });
      expect((await collector.next()).type).toBe("thread.message");
      expect((await collector.next()).type).toBe("thread.updated");
    } finally {
      collector.close();
      ws.close();
      await handle.close();
    }
  });

  it("delivers task.transitioned events to connected clients", async () => {
    const handle = await startHttpServer({
      root: repoRoot,
      host: "127.0.0.1",
      port: 0,
      version: "0.0.1",
    });

    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Transition me" }),
      });
      const created = (await res.json()) as { task: { slug: string } };
      const slug = created.task.slug;

      const { ws, collector } = await openSocket(`ws://127.0.0.1:${handle.port}/ws`);
      try {
        await collector.next(2000); // connected snapshot (task in backlog)

        const transitionRes = await fetch(
          `http://127.0.0.1:${handle.port}/api/tasks/${slug}/transition`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ to: "ready" }),
          },
        );
        expect(transitionRes.status).toBe(200);

        const event = await collector.next(2000);
        expect(event.type).toBe("task.transitioned");
        expect(event.payload).toMatchObject({
          slug,
          status: "ready",
          from: "backlog",
          to: "ready",
        });
      } finally {
        collector.close();
        ws.close();
      }
    } finally {
      await handle.close();
    }
  });

  it("sends a connected snapshot with existing tasks to late joiners", async () => {
    const handle = await startHttpServer({
      root: repoRoot,
      host: "127.0.0.1",
      port: 0,
      version: "0.0.1",
    });

    try {
      await fetch(`http://127.0.0.1:${handle.port}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Pre-existing" }),
      });

      const { ws, collector } = await openSocket(`ws://127.0.0.1:${handle.port}/ws`);
      try {
        const connected = await collector.next(2000);
        expect(connected.type).toBe("connected");
        expect(connected.payload.tasks).toHaveLength(1);
        expect(connected.payload.tasks[0]).toMatchObject({
          slug: "pre-existing",
          title: "Pre-existing",
        });
      } finally {
        collector.close();
        ws.close();
      }
    } finally {
      await handle.close();
    }
  });

  it("supports multiple concurrent clients receiving the same broadcast", async () => {
    const handle = await startHttpServer({
      root: repoRoot,
      host: "127.0.0.1",
      port: 0,
      version: "0.0.1",
    });

    try {
      const [{ ws: ws1, collector: c1 }, { ws: ws2, collector: c2 }] = await Promise.all([
        openSocket(`ws://127.0.0.1:${handle.port}/ws`),
        openSocket(`ws://127.0.0.1:${handle.port}/ws`),
      ]);

      try {
        await Promise.all([c1.next(2000), c2.next(2000)]);

        await fetch(`http://127.0.0.1:${handle.port}/api/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Broadcast" }),
        });

        const [m1, m2] = await Promise.all([c1.next(2000), c2.next(2000)]);
        expect(m1.type).toBe("task.created");
        expect(m1.payload.title).toBe("Broadcast");
        expect(m2.type).toBe("task.created");
        expect(m2.payload.title).toBe("Broadcast");
      } finally {
        c1.close();
        c2.close();
        ws1.close();
        ws2.close();
      }
    } finally {
      await handle.close();
    }
  });

  it("keeps the HTTP server healthy after a client drops abruptly", async () => {
    const handle = await startHttpServer({
      root: repoRoot,
      host: "127.0.0.1",
      port: 0,
      version: "0.0.1",
    });

    try {
      const { ws, collector } = await openSocket(`ws://127.0.0.1:${handle.port}/ws`);
      try {
        const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
        ws.terminate();
        await closed;
        collector.close();
      } finally {
        try {
          ws.close();
        } catch {
          // already closed
        }
      }

      await new Promise((r) => setTimeout(r, 100));

      const health = await fetch(`http://127.0.0.1:${handle.port}/api/health`);
      expect(health.status).toBe(200);
    } finally {
      await handle.close();
    }
  });

  it("rejects unauthenticated upgrades and accepts a logged-in session", async () => {
    const handle = await startHttpServer({
      root: repoRoot,
      host: "127.0.0.1",
      port: 0,
      version: "0.0.1",
      uiPassword: "secret",
    });
    try {
      await expectRejectedSocket(`ws://127.0.0.1:${handle.port}/ws`);
      const login = await fetch(`http://127.0.0.1:${handle.port}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "secret" }),
      });
      const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
      const { ws, collector } = await openSocket(`ws://127.0.0.1:${handle.port}/ws`, {
        headers: { Cookie: cookie },
      });
      try {
        expect((await collector.next()).type).toBe("connected");
      } finally {
        collector.close();
        ws.close();
      }
    } finally {
      await handle.close();
    }
  });

  it("applies authentication and origin protection to terminal WebSocket channels", async () => {
    const handle = await startHttpServer({ root: repoRoot, host: "127.0.0.1", port: 0, version: "0.0.1", uiPassword: "secret" });
    try {
      await expectRejectedSocket(`ws://127.0.0.1:${handle.port}/ws/terminal/unknown`);
      const login = await fetch(`http://127.0.0.1:${handle.port}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "secret" }) });
      const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
      await expectRejectedSocket(`ws://127.0.0.1:${handle.port}/ws/terminal/unknown`, { Cookie: cookie, Origin: "https://evil.example" });
      await expectPolicyClosedSocket(`ws://127.0.0.1:${handle.port}/ws/terminal/unknown`, { Cookie: cookie });
    } finally { await handle.close(); }
  });

  it("rejects a browser origin that is neither its own nor trusted", async () => {
    const handle = await startHttpServer({
      root: repoRoot,
      host: "127.0.0.1",
      port: 0,
      version: "0.0.1",
      uiPassword: "secret",
    });
    try {
      await expectRejectedSocket(`ws://127.0.0.1:${handle.port}/ws`, {
        Origin: "https://evil.example",
      });
    } finally {
      await handle.close();
    }
  });
});

function expectRejectedSocket(url: string, headers?: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("unauthenticated WebSocket connection was not rejected"));
    }, 2000);
    ws.once("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      response.resume();
      resolve();
    });
    ws.once("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function expectPolicyClosedSocket(url: string, headers?: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("terminal WebSocket was not policy-closed")); }, 2000);
    ws.once("close", (code) => { clearTimeout(timer); code === 1008 ? resolve() : reject(new Error(`unexpected close code ${code}`)); });
    ws.once("error", () => { /* close carries the policy result */ });
  });
}
