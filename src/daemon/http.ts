import { Hono, type Context } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import type { Server as HttpServer } from "node:http";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
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

export { DEFAULT_DAEMON_HOST, DEFAULT_DAEMON_PORT };

export interface HttpServerOptions {
  root?: string;
  host?: string;
  port?: number;
  version?: string;
  config?: GlobalConfig;
}

export interface HttpServerHandle {
  host: string;
  port: number;
  portFile: string;
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
}

export function buildApp(version: string, options: BuildAppOptions = {}): Hono {
  const root = options.root;
  const app = new Hono();
  app.get("/api/health", (c) => c.json({ status: "ok", version }));
  registerTaskRoutes(app, root, options.worktreeRoot);
  app.notFound((c) => c.json({ error: "Not found" }, 404));
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
  logger.error({ err }, "Unexpected error in task HTTP handler");
  return new ApiError(500, "Internal server error", "internal_error");
}

function registerTaskRoutes(app: Hono, root?: string, worktreeRoot?: string): void {
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
      const task = transitionTask(slug, toStr, root);
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
      if (specOverride !== undefined) {
        setSpecMarkdown(slug, specOverride, root);
      }
      const task = transitionTask(slug, "ready", root);
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

  const app = buildApp(version, { root });
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

  const portFile = portFilePath(root);
  writeFileSync(portFile, String(bound.port));

  logger.info({ host: bound.host, port: bound.port, portFile }, "HTTP server listening");

  return {
    host: bound.host,
    port: bound.port,
    portFile,
    close() {
      return closeServer(server, portFile);
    },
  };
}

async function closeServer(server: ServerType, portFile: string): Promise<void> {
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