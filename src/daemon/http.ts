import { Hono, type Context } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import type { Server as HttpServer } from "node:http";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { cwd } from "node:process";
import { fileURLToPath } from "node:url";
import { logger } from "../logger.js";
import { getRepoStateDir, initRepoState } from "./config.js";
import {
  DEFAULT_DAEMON_HOST,
  DEFAULT_DAEMON_PORT,
  resolveDaemonBind,
  type GlobalConfig,
} from "../worktree/config.js";
import {
  createTask,
  DuplicateSlugError,
  getTask,
  listTasks,
  setSpecMarkdown,
  TaskNotFoundError,
  transitionTask,
  type Task,
} from "../tasks/store.js";
import { InvalidTransitionError, isTaskStatus, type TaskStatus } from "../tasks/state-machine.js";
import { freezeTask, FreezeError } from "../tasks/freeze.js";
import { generateUniqueSlug } from "../tasks/slug.js";
import { WorktreeManager } from "../worktree/manager.js";
import {
  EventBus,
  publishTaskCreated,
  publishTaskTransitioned,
  publishTaskUpdated,
  type TaskPayload,
} from "./bus.js";
import { attachWebSocket, type WebSocketBridgeHandle } from "./ws.js";
import {
  DEFAULT_RUN_EVENTS_LIMIT,
  MAX_RUN_EVENTS_LIMIT,
  RunNotFoundError,
  RunLog,
  type RunEventRecord,
  type RunRecord,
} from "./run-log.js";

export { DEFAULT_DAEMON_HOST, DEFAULT_DAEMON_PORT };

export interface HttpServerOptions {
  root?: string;
  host?: string;
  port?: number;
  version?: string;
  config?: GlobalConfig;
  bus?: EventBus;
  attachWebSockets?: boolean;
  webDir?: string;
}

export interface HttpServerHandle {
  host: string;
  port: number;
  portFile: string;
  bus: EventBus;
  close(): Promise<void>;
}

function readVersion(): string {
  const __dirname = fileURLToPath(new URL(".", import.meta.url));
  const pkgPath = resolve(__dirname, "../../package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  return pkg.version as string;
}

export function portFilePath(root = cwd()): string {
  return resolve(getRepoStateDir(root), "daemon.port");
}

export interface BuildAppOptions {
  root?: string;
  worktreeRoot?: string;
  bus?: EventBus;
  webDir?: string;
}

export function defaultWebDistDir(): string {
  const __dirname = fileURLToPath(new URL(".", import.meta.url));
  return resolve(__dirname, "../../web/dist");
}

export function buildApp(version: string, options: BuildAppOptions = {}): Hono {
  const root = options.root;
  const bus = options.bus;
  const webDir = options.webDir ?? defaultWebDistDir();
  const app = new Hono();
  app.get("/api/health", (c) => c.json({ status: "ok", version }));
  registerTaskRoutes(app, root, options.worktreeRoot, bus);
  registerRunRoutes(app, root);
  registerStaticRoutes(app, webDir);
  app.notFound((c) => spaNotFound(c, webDir));
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      const body: { error: string; code?: string } = { error: err.message };
      if (err.code !== undefined) body.code = err.code;
      return c.json(body, err.status);
    }
    logger.error({ err }, "Unhandled HTTP error");
    return c.json({ error: "Internal server error" }, 500);
  });
  return app;
}

type StatusCode = 200 | 201 | 400 | 404 | 409 | 422 | 500;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

function mimeFor(ext: string): string {
  return MIME_TYPES[ext.toLowerCase()] ?? "application/octet-stream";
}

function registerStaticRoutes(app: Hono, webDir: string): void {
  app.get("/", (c) => serveSpaIndex(c, webDir));
  app.get("/assets/*", (c) => serveAsset(c, webDir));
}

function serveSpaIndex(c: Context, webDir: string): Response {
  const indexHtml = resolve(webDir, "index.html");
  if (!existsSync(indexHtml) || !statSync(indexHtml).isFile()) {
    const body =
      "<!doctype html><h1>Web bundle not built</h1>" +
      "<p>The Marshal web bundle has not been built. Run " +
      "<code>pnpm run build:web</code> and restart the daemon.</p>";
    return new Response(body, {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  const body = readFileSync(indexHtml);
  return new Response(body, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function serveAsset(c: Context, webDir: string): Response {
  const prefix = "/assets/";
  const path = c.req.path;
  if (!path.startsWith(prefix)) {
    return c.json({ error: "Not found" }, 404);
  }
  const rel = path.slice(prefix.length);
  const assetsBase = resolve(webDir, "assets");
  const filePath = resolve(assetsBase, rel);
  if (
    !filePath.startsWith(assetsBase + sep) ||
    !existsSync(filePath) ||
    !statSync(filePath).isFile()
  ) {
    return c.json({ error: "Not found" }, 404);
  }
  const body = readFileSync(filePath);
  return new Response(body, {
    headers: { "Content-Type": mimeFor(extname(filePath)) },
  });
}

function spaNotFound(c: Context, webDir: string): Response {
  const path = c.req.path;
  if (path === "/api/health" || path.startsWith("/api/") || path.startsWith("/assets/")) {
    return c.json({ error: "Not found" }, 404);
  }
  return serveSpaIndex(c, webDir);
}

class ApiError extends Error {
  constructor(
    readonly status: StatusCode,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface TaskCardFields {
  id: number;
  slug: string;
  title: string;
  status: TaskStatus;
  retry_count: number;
  created_at: string;
  updated_at: string;
}

interface TaskDetailFields extends TaskCardFields {
  spec_markdown: string;
  last_failure: string | null;
}

function taskCard(task: Task): TaskCardFields {
  return {
    id: task.id,
    slug: task.slug,
    title: task.title,
    status: task.status,
    retry_count: task.retry_count,
    created_at: task.created_at,
    updated_at: task.updated_at,
  };
}

function taskPayload(task: Task): TaskPayload {
  return taskCard(task);
}

function taskDetail(task: Task): TaskDetailFields {
  return {
    ...taskCard(task),
    spec_markdown: task.spec_markdown,
    last_failure: task.last_failure,
  };
}

async function readJsonObject(
  c: Context,
  allowedFields: ReadonlySet<string>,
): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await c.req.text();
  } catch {
    throw new ApiError(400, "Request body could not be read", "invalid_body");
  }
  if (raw.length === 0) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError(400, "Request body is not valid JSON", "invalid_json");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(400, "Request body must be a JSON object", "invalid_body");
  }
  const obj = parsed as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!allowedFields.has(key)) {
      throw new ApiError(400, `Unknown field: ${key}`, "unknown_field");
    }
  }
  return obj;
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ApiError(422, `${field} must be a string`, "invalid_field");
  }
  return value;
}

function mapDomainError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof TaskNotFoundError) {
    return new ApiError(404, err.message, "task_not_found");
  }
  if (err instanceof DuplicateSlugError) {
    return new ApiError(409, err.message, "duplicate_slug");
  }
  if (err instanceof InvalidTransitionError) {
    return new ApiError(409, err.message, "invalid_transition");
  }
  if (err instanceof FreezeError) {
    return new ApiError(409, err.message, "freeze_failed");
  }
  if (err instanceof RunNotFoundError) {
    return new ApiError(404, err.message, "run_not_found");
  }
  logger.error({ err }, "Unexpected error in task HTTP handler");
  return new ApiError(500, "Internal server error", "internal_error");
}

function registerTaskRoutes(
  app: Hono,
  root: string | undefined,
  worktreeRoot: string | undefined,
  bus: EventBus | undefined,
): void {
  app.get("/api/tasks", (c) => {
    const tasks = listTasks(root).map(taskCard);
    return c.json({ tasks });
  });

  app.get("/api/tasks/:slug", (c) => {
    const slug = c.req.param("slug");
    try {
      const task = getTask(slug, root);
      return c.json({ task: taskDetail(task) });
    } catch (err) {
      throw mapDomainError(err);
    }
  });

  app.post("/api/tasks", async (c) => {
    const body = await readJsonObject(c, new Set(["title", "spec_markdown"]));
    const title = body.title;
    if (title === undefined) {
      throw new ApiError(422, "title is required", "missing_field");
    }
    const titleStr = assertString(title, "title");
    if (titleStr.trim().length === 0) {
      throw new ApiError(422, "title must not be empty", "invalid_field");
    }
    let specMarkdown: string | undefined;
    if (body.spec_markdown !== undefined) {
      specMarkdown = assertString(body.spec_markdown, "spec_markdown");
    }
    try {
      const slug = generateUniqueSlug(titleStr, root);
      const task = createTask({ slug, title: titleStr, specMarkdown }, root);
      if (bus) publishTaskCreated(bus, taskPayload(task));
      return c.json({ task: taskDetail(task) }, 201);
    } catch (err) {
      throw mapDomainError(err);
    }
  });

  app.post("/api/tasks/:slug/transition", async (c) => {
    const slug = c.req.param("slug");
    const body = await readJsonObject(c, new Set(["to"]));
    const to = body.to;
    if (to === undefined) {
      throw new ApiError(422, "to is required", "missing_field");
    }
    const toStr = assertString(to, "to");
    if (!isTaskStatus(toStr)) {
      throw new ApiError(422, `Unknown status: ${toStr}`, "unknown_status");
    }
    try {
      const fromTask = getTask(slug, root);
      const from = fromTask.status;
      const task = transitionTask(slug, toStr, root);
      if (bus) publishTaskTransitioned(bus, taskPayload(task), from, toStr);
      return c.json({ task: taskDetail(task) });
    } catch (err) {
      throw mapDomainError(err);
    }
  });

  app.post("/api/tasks/:slug/ready", async (c) => {
    const slug = c.req.param("slug");
    const body = await readJsonObject(c, new Set(["specMarkdown"]));
    let specOverride: string | undefined;
    if (body.specMarkdown !== undefined) {
      specOverride = assertString(body.specMarkdown, "specMarkdown");
    }
    try {
      const fromTask = getTask(slug, root);
      const from = fromTask.status;
      if (specOverride !== undefined) {
        setSpecMarkdown(slug, specOverride, root);
        if (bus) publishTaskUpdated(bus, taskPayload(getTask(slug, root)));
      }
      const task = transitionTask(slug, "ready", root);
      if (bus) publishTaskTransitioned(bus, taskPayload(task), from, "ready");
      const manager =
        worktreeRoot !== undefined
          ? new WorktreeManager(root ?? process.cwd(), { worktreeRoot })
          : undefined;
      freezeTask(slug, root, manager);
      return c.json({ task: taskDetail(task) });
    } catch (err) {
      throw mapDomainError(err);
    }
  });
}

interface RunCardFields {
  id: number;
  task_id: number;
  role: string;
  agent_id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  commit_sha: string | null;
  error: string | null;
}

interface RunDetailFields extends RunCardFields {
  prompt: string | null;
}

interface RunEventFields {
  seq: number;
  type: string;
  payload: unknown;
  created_at: string;
}

function runCard(run: RunRecord): RunCardFields {
  return {
    id: run.id,
    task_id: run.taskId,
    role: run.role,
    agent_id: run.agentId,
    status: run.status,
    started_at: run.startedAt,
    ended_at: run.endedAt,
    commit_sha: run.commitSha,
    error: run.error,
  };
}

function runDetail(run: RunRecord): RunDetailFields {
  return { ...runCard(run), prompt: run.prompt };
}

function runEventFields(event: RunEventRecord): RunEventFields {
  return {
    seq: event.seq,
    type: event.type,
    payload: event.payload,
    created_at: event.createdAt,
  };
}

function parseNonNegativeInt(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ApiError(400, `${field} must be a non-negative integer`, "invalid_query");
  }
  return parsed;
}

function registerRunRoutes(app: Hono, root: string | undefined): void {
  app.get("/api/tasks/:slug/runs", (c) => {
    const slug = c.req.param("slug");
    try {
      const task = getTask(slug, root);
      const log = new RunLog(root);
      const runs = log.listRunsForTask(task.id).map(runCard);
      return c.json({ runs });
    } catch (err) {
      throw mapDomainError(err);
    }
  });

  app.get("/api/runs/:id", (c) => {
    const runId = parseRunId(c.req.param("id"));
    const log = new RunLog(root);
    const run = log.getRun(runId);
    if (run === undefined) throw new ApiError(404, `Run not found: ${runId}`, "run_not_found");
    return c.json({ run: runDetail(run) });
  });

  app.get("/api/runs/:id/events", (c) => {
    const runId = parseRunId(c.req.param("id"));
    let afterSeq: number | undefined;
    if (c.req.query("after_seq") !== undefined) {
      afterSeq = parseNonNegativeInt(c.req.query("after_seq")!, "after_seq");
    }
    let limit = DEFAULT_RUN_EVENTS_LIMIT;
    if (c.req.query("limit") !== undefined) {
      limit = parseNonNegativeInt(c.req.query("limit")!, "limit");
      if (limit > MAX_RUN_EVENTS_LIMIT) {
        throw new ApiError(422, `limit must be at most ${MAX_RUN_EVENTS_LIMIT}`, "invalid_limit");
      }
    }
    const log = new RunLog(root);
    if (log.getRun(runId) === undefined) {
      throw new ApiError(404, `Run not found: ${runId}`, "run_not_found");
    }
    const events = log.getEvents(runId, { afterSeq, limit }).map(runEventFields);
    const nextAfterSeq = events.length > 0 ? events[events.length - 1].seq : null;
    return c.json({ events, next_after_seq: nextAfterSeq });
  });
}

function parseRunId(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ApiError(400, "run id must be a positive integer", "invalid_run_id");
  }
  return parsed;
}

async function waitForListening(server: ServerType): Promise<{ host: string; port: number }> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (err: Error): void => {
      server.off("listening", onListening);
      rejectListen(err);
    };
    const onListening = (): void => {
      server.off("error", onError);
      const address = server.address();
      if (address !== null && typeof address === "object") {
        resolveListen({ host: address.address, port: address.port });
      } else {
        rejectListen(new Error("Server bound to a non-IP address"));
      }
    };
    server.once("listening", onListening);
    server.once("error", onError);
  });
}

export async function startHttpServer(options: HttpServerOptions = {}): Promise<HttpServerHandle> {
  const root = options.root ?? cwd();
  initRepoState(root);

  const { host, port } = resolveDaemonBind(
    { host: options.host, port: options.port },
    options.config,
  );
  const version = options.version ?? readVersion();
  const bus = options.bus ?? new EventBus();
  const attachWs = options.attachWebSockets ?? true;

  const app = buildApp(version, { root, bus, webDir: options.webDir });
  const server = serve({ fetch: app.fetch, hostname: host, port });

  let bound: { host: string; port: number };
  try {
    bound = await waitForListening(server);
  } catch (err) {
    try {
      server.close();
    } catch {
      // ignore
    }
    throw err;
  }

  let wsHandle: WebSocketBridgeHandle | undefined;
  if (attachWs) {
    wsHandle = attachWebSocket(server as HttpServer, bus, () => listTasks(root).map(taskCard), {
      path: "/ws",
    });
  }

  const portFile = portFilePath(root);
  writeFileSync(portFile, String(bound.port));

  logger.info({ host: bound.host, port: bound.port, portFile }, "HTTP server listening");

  return {
    host: bound.host,
    port: bound.port,
    portFile,
    bus,
    close() {
      return closeServer(server, portFile, wsHandle);
    },
  };
}

async function closeServer(
  server: ServerType,
  portFile: string,
  wsHandle?: WebSocketBridgeHandle,
): Promise<void> {
  if (wsHandle) {
    try {
      await wsHandle.close();
    } catch (err) {
      logger.warn({ err }, "WebSocket bridge close failed");
    }
  }
  await new Promise<void>((resolveClose) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolveClose();
    };
    server.close(() => finish());
    // Force-close lingering keep-alive sockets after a short grace period so
    // graceful shutdown does not hang on idle HTTP connections.
    setTimeout(() => {
      try {
        (server as HttpServer).closeAllConnections?.();
      } catch {
        // ignore
      }
    }, 1000).unref();
  });

  try {
    if (existsSync(portFile)) {
      unlinkSync(portFile);
    }
  } catch (err) {
    logger.warn({ err, portFile }, "Failed to remove daemon.port file");
  }
}
