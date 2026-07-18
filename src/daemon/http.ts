import { Hono, type Context } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import type { Server as HttpServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { extname, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { cwd } from "node:process";
import { fileURLToPath } from "node:url";
import { logger } from "../logger.js";
import { getRepoStateDir, initRepoState } from "./config.js";
import {
  DEFAULT_DAEMON_HOST,
  DEFAULT_DAEMON_PORT,
  resolveDaemonBind,
  isLoopbackHost,
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
import { DiffError, MergeError } from "../worktree/diff-merge.js";
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
import { runSpecAuthorTurn, SpecChatClosedError } from "./spec-chat.js";
import { listSpecMessages, type SpecMessage } from "../tasks/spec-store.js";
import { publishSpecMessage } from "./bus.js";
import type { Agent } from "../agent/types.js";
import { resolveAgentId, MissingAgentIdError } from "../worktree/config.js";
import {
  appendChatMessage,
  ChatThreadNotFoundError,
  createChatThread,
  deleteChatThread,
  getChatThread,
  isChatThreadStatus,
  listChatMessages,
  listChatThreads,
  updateChatThread,
} from "../chat/store.js";
import { publishThreadCreated, publishThreadDeleted, publishThreadMessage, publishThreadUpdated } from "./bus.js";
import { ChatAgentUnavailableError, ChatTurnBusyError, ChatTurnRunner } from "./chat-turn.js";
import { ChatFileTooLargeError, InvalidChatPathError, listChatFiles, readChatFile } from "../chat/files.js";
import { ChatAttachmentError, createChatAttachment, listChatAttachments, MAX_ATTACHMENT_BYTES, readChatAttachment } from "../chat/attachments.js";
import { AuthService } from "./auth.js";
import { getRepository, getSelectedRepository, listRepositories, registerRepository, removeRepository, selectRepository, repositoryRoot, RepositoryError } from "../repositories/store.js";
import { fetchRegistrySnapshot } from "../registry/fetch.js";
import { beginRegistryRefresh, completeRegistryRefresh, failRegistryRefresh, getRegistryCatalog } from "../registry/store.js";
import { PUBLIC_REGISTRY_URL, type RegistryAgent } from "../registry/types.js";
import { beginAgentAuthentication, finishAgentAuthentication, getAgentAuthenticationOperation, getInstalledAgent, getLatestAgentAuthenticationOperation, interruptActiveAgentAuthentications, listInstalledAgents, removeInstalledAgent, setAgentReadiness } from "../agents/store.js";
import { installationOperation, startInstallation } from "../installations/installer.js";
import { probeAgent } from "../acp/probe.js";
import { authenticateAgent } from "../acp/authenticate.js";
import { listSessionEvents, listSessionsForOwner } from "../acp/supervisor-store.js";
import { randomUUID } from "node:crypto";
import { reconcileThreadPermissions } from "../acp/permission-store.js";
import { deleteWorkflowProfile, getWorkflowProfile, listWorkflowProfiles, saveWorkflowProfile, WorkflowValidationError, type WorkflowProfileInput } from "../workflows/store.js";
import { listSpecAuthorSessions, listSpecAuthorOperations } from "../tasks/author-store.js";

const authenticationControllers = new Map<string, AbortController>();

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
  uiPassword?: string;
  trustedOrigins?: string[];
  trustedProxy?: boolean;
  machineDir?: string;
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

export function portFilePath(root?: string): string {
  return resolve(getRepoStateDir(root), "daemon.port");
}

export interface BuildAppOptions {
  root?: string;
  worktreeRoot?: string;
  bus?: EventBus;
  webDir?: string;
  specAgent?: Agent;
  chatAgent?: Agent;
  auth?: AuthService;
  trustedProxy?: boolean;
  machineDir?: string;
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
  interruptActiveAgentAuthentications(options.machineDir);
  const auth = options.auth;
  if (auth) {
    app.use("/api/*", auth.middleware);
    app.get("/api/auth/status", (c) => c.json({ enabled: auth.enabled, authenticated: auth.isAuthenticated(c.req.header("Cookie")) }));
    app.post("/api/auth/login", async (c) => {
      const body = await readJsonObject(c, new Set(["password"]));
      if (typeof body.password !== "string") throw new ApiError(422, "password is required", "missing_field");
      const result = auth.login(body.password, authClientKey(c, options.trustedProxy));
      if (result.retryAfter !== undefined) {
        return new Response(JSON.stringify({ error: "Too many failed login attempts", code: "rate_limited" }), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(result.retryAfter) } });
      }
      if (!result.token) return c.json({ authenticated: true });
      return c.json({ authenticated: true }, 200, {
        "Set-Cookie": auth.cookie(result.token, undefined, isSecureRequest(c, options.trustedProxy)),
      });
    });
    app.post("/api/auth/logout", (c) => {
      auth.logout(c.req.header("Cookie"));
      return c.json({ authenticated: false }, 200, { "Set-Cookie": auth.clearCookie(isSecureRequest(c, options.trustedProxy)) });
    });
  }
  app.get("/api/health", (c) => c.json({ status: "ok", version }));
  registerRepositoryRoutes(app);
  registerRegistryRoutes(app, options.machineDir);
  registerAgentRoutes(app, options.machineDir);
  registerWorkflowProfileRoutes(app, options.machineDir);
  registerTaskRoutes(app, root, options.worktreeRoot, bus, options.machineDir);
  registerRunRoutes(app, root);
  registerSpecRoutes(app, root, bus, options.specAgent, options.machineDir);
  registerChatRoutes(app, root, bus, options.chatAgent, options.machineDir);
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

function authClientKey(c: Context, trustedProxy = false): string {
  if (trustedProxy) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  const incoming = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming;
  return incoming?.socket.remoteAddress ?? "unknown";
}

function isSecureRequest(c: Context, trustedProxy = false): boolean {
  return trustedProxy && c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
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
  repository_id?: string | null;
  workflow_profile_id?: string | null;
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
    repository_id: task.repository_id,
    workflow_profile_id: task.workflow_profile_id,
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
  if (err instanceof DiffError) {
    return new ApiError(409, err.message, "diff_failed");
  }
  if (err instanceof MergeError) {
    if (/conflict/i.test(err.message)) {
      return new ApiError(409, err.message, "merge_conflict");
    }
    return new ApiError(409, err.message, "merge_failed");
  }
  if (err instanceof RunNotFoundError) {
    return new ApiError(404, err.message, "run_not_found");
  }
  if (err instanceof SpecChatClosedError) {
    return new ApiError(409, err.message, "spec_chat_closed");
  }
  if (err instanceof MissingAgentIdError) {
    return new ApiError(400, err.message, "agent_not_configured");
  }
  if (err instanceof ChatThreadNotFoundError) {
    return new ApiError(404, err.message, "thread_not_found");
  }
  if (err instanceof ChatTurnBusyError) {
    return new ApiError(409, err.message, "thread_busy");
  }
  if (err instanceof ChatAgentUnavailableError) return new ApiError(409, err.message, err.code);
  if (err instanceof InvalidChatPathError) return new ApiError(422, err.message, "invalid_path");
  if (err instanceof ChatFileTooLargeError) return new ApiError(422, err.message, "file_too_large");
  if (err instanceof ChatAttachmentError) return new ApiError(422, err.message, err.code);
  if (err instanceof RepositoryError) return new ApiError(err.code === "duplicate_path" ? 409 : 422, err.message, err.code);
  if (err instanceof WorkflowValidationError) return new ApiError(422, err.message, "workflow_profile_invalid");
  logger.error({ err }, "Unexpected error in task HTTP handler");
  return new ApiError(500, "Internal server error", "internal_error");
}

function workflowInput(body: Record<string, unknown>): WorkflowProfileInput {
  const assignments = body.assignments;
  if (!Array.isArray(assignments)) throw new ApiError(422, "assignments must be an array", "invalid_field");
  return {
    name: assertString(body.name, "name"),
    permission_policy: assertString(body.permission_policy, "permission_policy") as WorkflowProfileInput["permission_policy"],
    unattended_authorized: body.unattended_authorized === true,
    timeout_ms: typeof body.timeout_ms === "number" ? body.timeout_ms : Number.NaN,
    max_retries: typeof body.max_retries === "number" ? body.max_retries : Number.NaN,
    verification_commands: Array.isArray(body.verification_commands) ? body.verification_commands.map((value) => assertString(value, "verification_commands")) : [],
    require_decorrelated_builder_validator: body.require_decorrelated_builder_validator === true,
    assignments: assignments.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(422, "assignments must contain objects", "invalid_field");
      const item = value as Record<string, unknown>;
      return { role: assertString(item.role, "assignment.role") as WorkflowProfileInput["assignments"][number]["role"], agent_id: assertString(item.agent_id, "assignment.agent_id"), agent_version: assertString(item.agent_version, "assignment.agent_version"), model: item.model == null ? null : assertString(item.model, "assignment.model"), mode: item.mode == null ? null : assertString(item.mode, "assignment.mode") };
    }),
  };
}

function registerWorkflowProfileRoutes(app: Hono, machineDir?: string): void {
  const fields = new Set(["name", "permission_policy", "unattended_authorized", "timeout_ms", "max_retries", "verification_commands", "require_decorrelated_builder_validator", "assignments"]);
  app.get("/api/repositories/:repositoryId/workflow-profiles", (c) => c.json({ profiles: listWorkflowProfiles(c.req.param("repositoryId"), machineDir) }));
  app.get("/api/repositories/:repositoryId/workflow-profiles/:id", (c) => {
    const found = getWorkflowProfile(c.req.param("repositoryId"), c.req.param("id"), machineDir);
    if (!found) throw new ApiError(404, "Workflow profile not found", "workflow_profile_not_found");
    return c.json({ profile: found });
  });
  app.post("/api/repositories/:repositoryId/workflow-profiles", async (c) => {
    const body = await readJsonObject(c, new Set([...fields, "id"]));
    try { return c.json({ profile: saveWorkflowProfile(c.req.param("repositoryId"), workflowInput(body), typeof body.id === "string" ? body.id as `${string}-${string}-${string}-${string}-${string}` : undefined, machineDir) }, 201); } catch (error) { throw mapDomainError(error); }
  });
  app.put("/api/repositories/:repositoryId/workflow-profiles/:id", async (c) => {
    const body = await readJsonObject(c, fields);
    try { return c.json({ profile: saveWorkflowProfile(c.req.param("repositoryId"), workflowInput(body), c.req.param("id") as `${string}-${string}-${string}-${string}-${string}`, machineDir) }); } catch (error) { throw mapDomainError(error); }
  });
  app.delete("/api/repositories/:repositoryId/workflow-profiles/:id", (c) => {
    if (!deleteWorkflowProfile(c.req.param("repositoryId"), c.req.param("id"), machineDir)) throw new ApiError(404, "Workflow profile not found", "workflow_profile_not_found");
    return c.json({ deleted: true });
  });
}

function registerRepositoryRoutes(app: Hono): void {
  app.get("/api/repositories", (c) => c.json({ repositories: listRepositories(), selected_repository_id: getSelectedRepository()?.id ?? null }));
  app.get("/api/repositories/selected", (c) => c.json({ repository: getSelectedRepository() ?? null }));
  app.get("/api/repositories/:id", (c) => {
    const repository = getRepository(c.req.param("id"));
    if (!repository) throw new ApiError(404, "Repository not found", "repository_not_found");
    return c.json({ repository });
  });
  app.post("/api/repositories", async (c) => {
    const body = await readJsonObject(c, new Set(["path"]));
    if (body.path === undefined) throw new ApiError(422, "path is required", "missing_field");
    try { return c.json({ repository: registerRepository(assertString(body.path, "path")) }, 201); }
    catch (err) { throw mapDomainError(err); }
  });
  app.post("/api/repositories/:id/select", (c) => {
    try { return c.json({ repository: selectRepository(c.req.param("id")) }); }
    catch (err) { if (err instanceof Error && /not found/.test(err.message)) throw new ApiError(404, err.message, "repository_not_found"); throw mapDomainError(err); }
  });
  app.delete("/api/repositories/:id", (c) => {
    if (!removeRepository(c.req.param("id"))) throw new ApiError(404, "Repository not found", "repository_not_found");
    return c.json({ deleted: true });
  });
}

function registryAgent(agent: RegistryAgent): RegistryAgent {
  return agent;
}

function registerRegistryRoutes(app: Hono, machineDir?: string): void {
  app.get("/api/registry", (c) => {
    const catalog = getRegistryCatalog(machineDir);
    return c.json({ ...catalog, source: catalog.snapshot?.source ?? PUBLIC_REGISTRY_URL });
  });
  app.get("/api/registry/agents", (c) => {
    const catalog = getRegistryCatalog(machineDir);
    const query = c.req.query("q")?.trim().toLowerCase() ?? "";
    const agents = (catalog.snapshot?.agents ?? []).filter((agent) => !query || [agent.id, agent.name, agent.description].some((field) => field.toLowerCase().includes(query))).map(registryAgent);
    return c.json({ agents, snapshot: catalog.snapshot, refresh: catalog.refresh });
  });
  app.get("/api/registry/agents/:id", (c) => {
    const catalog = getRegistryCatalog(machineDir);
    const agent = catalog.snapshot?.agents.find((entry) => entry.id === c.req.param("id"));
    if (!agent) throw new ApiError(404, "Registry agent not found", "registry_agent_not_found");
    return c.json({ agent: registryAgent(agent), snapshot: catalog.snapshot, refresh: catalog.refresh });
  });
  app.post("/api/registry/refresh", (c) => {
    const current = getRegistryCatalog(machineDir).refresh;
    if (current?.status === "running") return c.json({ refresh: current }, 202);
    const refresh = beginRegistryRefresh(machineDir);
    void fetchRegistrySnapshot().then((snapshot) => completeRegistryRefresh(refresh.id, snapshot, machineDir)).catch((error: unknown) => {
      failRegistryRefresh(refresh.id, error instanceof Error ? error.message : "Registry refresh failed", machineDir);
    });
    return c.json({ refresh }, 202);
  });
}

function registerAgentRoutes(app: Hono, machineDir?: string): void {
  app.get("/api/agents", (c) => c.json({ agents: listInstalledAgents(machineDir) }));
  app.get("/api/agents/:id", (c) => {
    const version = c.req.query("version");
    if (!version) throw new ApiError(422, "version is required", "missing_query");
    const installed = getInstalledAgent(c.req.param("id"), version, machineDir);
    if (!installed) throw new ApiError(404, "Installed agent not found", "agent_not_found");
    return c.json({ agent: installed });
  });
  app.post("/api/agents/:id/probe", async (c) => {
    const version = c.req.query("version");
    if (!version) throw new ApiError(422, "version is required", "missing_query");
    const installed = getInstalledAgent(c.req.param("id"), version, machineDir);
    if (!installed || installed.status !== "installed") throw new ApiError(409, "Only an installed agent can be probed", "agent_not_installed");
    const workspace = mkdtempSync(resolve(tmpdir(), "marshal-probe-"));
    const started = new Date().toISOString();
    setAgentReadiness(installed.id, installed.version, { readiness_status: "probing", readiness_error: null, protocol_version: installed.protocol_version, capabilities: installed.capabilities, auth_methods: installed.auth_methods, raw_initialize: installed.raw_initialize, probed_at: started }, machineDir);
    try {
      const result = await probeAgent(workspace, installed.launch);
      const agent = setAgentReadiness(installed.id, installed.version, { readiness_status: result.status, readiness_error: result.error, protocol_version: result.protocol_version, capabilities: result.capabilities, auth_methods: result.auth_methods, raw_initialize: result.raw_initialize, probed_at: new Date().toISOString() }, machineDir);
      return c.json({ agent });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
  app.get("/api/agents/:id/auth", (c) => {
    const version = c.req.query("version");
    if (!version) throw new ApiError(422, "version is required", "missing_query");
    const installed = getInstalledAgent(c.req.param("id"), version, machineDir);
    if (!installed) throw new ApiError(404, "Installed agent not found", "agent_not_found");
    return c.json({ agent: installed, authentication: getLatestAgentAuthenticationOperation(installed.id, installed.version, machineDir) ?? null });
  });
  app.post("/api/agents/:id/auth", async (c) => {
    const version = c.req.query("version");
    if (!version) throw new ApiError(422, "version is required", "missing_query");
    const body = await readJsonObject(c, new Set(["method_id"]));
    const methodId = assertString(body.method_id, "method_id");
    const installed = getInstalledAgent(c.req.param("id"), version, machineDir);
    if (!installed || installed.status !== "installed") throw new ApiError(409, "Only an installed agent can authenticate", "agent_not_installed");
    const method = installed.auth_methods.find((entry) => entry.id === methodId);
    if (!method || method.type !== "agent") throw new ApiError(422, "Only an advertised agent-managed authentication method can be selected", "auth_method_invalid");
    const current = getLatestAgentAuthenticationOperation(installed.id, installed.version, machineDir);
    if (current?.status === "authenticating") return c.json({ authentication: current }, 202);
    const operation = beginAgentAuthentication({ id: randomUUID(), agent_id: installed.id, version: installed.version, method_id: method.id, method_name: method.name }, machineDir);
    const controller = new AbortController();
    authenticationControllers.set(operation.id, controller);
    void (async () => {
      const workspace = mkdtempSync(resolve(tmpdir(), "marshal-auth-"));
      try {
        await authenticateAgent(workspace, installed.launch, method.id, controller.signal);
        finishAgentAuthentication(operation.id, "succeeded", null, machineDir);
        const refreshed = getInstalledAgent(installed.id, installed.version, machineDir);
        if (refreshed) {
          const result = await probeAgent(workspace, refreshed.launch);
          setAgentReadiness(refreshed.id, refreshed.version, { readiness_status: result.status, readiness_error: result.error, protocol_version: result.protocol_version, capabilities: result.capabilities, auth_methods: result.auth_methods, raw_initialize: result.raw_initialize, probed_at: new Date().toISOString() }, machineDir);
        }
      } catch (error) {
        const cancelled = controller.signal.aborted;
        finishAgentAuthentication(operation.id, cancelled ? "cancelled" : "failed", cancelled ? "Authentication was cancelled" : error instanceof Error ? error.message : String(error), machineDir);
      } finally {
        authenticationControllers.delete(operation.id);
        rmSync(workspace, { recursive: true, force: true });
      }
    })();
    return c.json({ authentication: operation }, 202);
  });
  app.get("/api/agents/auth/operations/:id", (c) => {
    const operation = getAgentAuthenticationOperation(c.req.param("id"), machineDir);
    if (!operation) throw new ApiError(404, "Authentication operation not found", "operation_not_found");
    return c.json({ authentication: operation });
  });
  app.post("/api/agents/auth/operations/:id/cancel", (c) => {
    const operation = getAgentAuthenticationOperation(c.req.param("id"), machineDir);
    if (!operation) throw new ApiError(404, "Authentication operation not found", "operation_not_found");
    if (operation.status === "authenticating") authenticationControllers.get(operation.id)?.abort();
    return c.json({ authentication: getAgentAuthenticationOperation(operation.id, machineDir) });
  });
  app.post("/api/agents/install", async (c) => {
    const body = await readJsonObject(c, new Set(["agent_id", "version"]));
    const agentId = assertString(body.agent_id, "agent_id");
    const version = assertString(body.version, "version");
    const catalog = getRegistryCatalog(machineDir);
    const registryAgent = catalog.snapshot?.agents.find((agent) => agent.id === agentId && agent.version === version);
    if (!registryAgent) throw new ApiError(404, "Registry agent version not found", "registry_agent_not_found");
    try {
      return c.json({ operation: await startInstallation(registryAgent, machineDir) }, 202);
    } catch (error) {
      throw new ApiError(422, error instanceof Error ? error.message : String(error), "installation_invalid");
    }
  });
  app.get("/api/agents/operations/:id", (c) => {
    try { return c.json({ operation: installationOperation(c.req.param("id"), machineDir) }); }
    catch { throw new ApiError(404, "Installation operation not found", "operation_not_found"); }
  });
  app.delete("/api/agents/:id", (c) => {
    const version = c.req.query("version");
    if (!version) throw new ApiError(422, "version is required", "missing_query");
    if (!removeInstalledAgent(c.req.param("id"), version, machineDir)) throw new ApiError(404, "Installed agent not found", "agent_not_found");
    return c.json({ deleted: true });
  });
}

function registerChatRoutes(app: Hono, root: string | undefined, bus: EventBus | undefined, chatAgent?: Agent, machineDir?: string): void {
  const turns = new ChatTurnRunner({ root, bus, agent: chatAgent, machineDir });
  app.get("/api/threads", (c) => c.json({ threads: listChatThreads(root, c.req.query("archived") === "true") }));
  app.post("/api/threads", async (c) => {
    const body = await readJsonObject(c, new Set(["agent_id", "agent_version", "cwd", "title", "task_slug"]));
    if (body.agent_id === undefined) throw new ApiError(422, "agent_id is required", "missing_field");
    const agentId = assertString(body.agent_id, "agent_id");
    if (body.agent_version === undefined) throw new ApiError(422, "agent_version is required", "missing_field");
    const agentVersion = assertString(body.agent_version, "agent_version");
    if (!agentId.trim()) throw new ApiError(422, "agent_id must not be empty", "invalid_field");
    const installed = getInstalledAgent(agentId, agentVersion, machineDir);
    if (!chatAgent && (!installed || installed.status !== "installed")) throw new ApiError(409, "Only an installed agent can be selected for a thread", "agent_not_installed");
    if (!chatAgent && installed?.readiness_status !== "ready") throw new ApiError(409, `Agent ${agentId}@${agentVersion} is not ready`, "agent_not_ready");
    const thread = createChatThread({
      agentId,
      agentVersion,
      cwd: body.cwd === undefined ? undefined : assertString(body.cwd, "cwd"),
      title: body.title === undefined ? undefined : assertString(body.title, "title"),
      taskSlug: body.task_slug === undefined ? undefined : assertString(body.task_slug, "task_slug"),
    }, root);
    if (bus) publishThreadCreated(bus, thread);
    return c.json({ thread }, 201);
  });
  app.get("/api/threads/:id", (c) => {
    try {
      const thread = getChatThread(c.req.param("id"), root);
      return c.json({ thread, messages: listChatMessages(thread.id, root), attachments: listChatAttachments(thread.id, root), events: listSessionEventsForThread(thread.id, root) });
    } catch (err) {
      throw mapDomainError(err);
    }
  });
  app.get("/api/threads/:id/events", (c) => {
    try {
      getChatThread(c.req.param("id"), root);
      const sessions = listSessionEventsForThread(c.req.param("id"), root);
      return c.json({ events: sessions });
    } catch (err) { throw mapDomainError(err); }
  });
  app.patch("/api/threads/:id", async (c) => {
    const body = await readJsonObject(c, new Set(["title", "status", "archived", "pinned", "scratch_markdown"]));
    if (body.title !== undefined && typeof body.title !== "string") throw new ApiError(422, "title must be a string", "invalid_field");
    if (body.status !== undefined && (typeof body.status !== "string" || !isChatThreadStatus(body.status))) throw new ApiError(422, "status is invalid", "invalid_field");
    for (const field of ["archived", "pinned"] as const) {
      if (body[field] !== undefined && typeof body[field] !== "boolean") throw new ApiError(422, `${field} must be a boolean`, "invalid_field");
    }
    if (body.scratch_markdown !== undefined && typeof body.scratch_markdown !== "string") throw new ApiError(422, "scratch_markdown must be a string", "invalid_field");
    try {
      if (body.status === "closed") await turns.closeThread(c.req.param("id"));
      const thread = updateChatThread(c.req.param("id"), {
        title: body.title as string | undefined,
        status: body.status as "draft" | "active" | "closed" | "error" | undefined,
        archived: body.archived as boolean | undefined,
        pinned: body.pinned as boolean | undefined,
        scratchMarkdown: body.scratch_markdown as string | undefined,
      }, root);
      if (bus) publishThreadUpdated(bus, thread);
      return c.json({ thread });
    } catch (err) {
      throw mapDomainError(err);
    }
  });
  app.delete("/api/threads/:id", async (c) => {
    try {
      await turns.closeThread(c.req.param("id"));
      reconcileThreadPermissions(c.req.param("id"), root);
      deleteChatThread(c.req.param("id"), root);
      if (bus) publishThreadDeleted(bus, c.req.param("id"));
      return c.json({ deleted: true });
    } catch (err) {
      throw mapDomainError(err);
    }
  });
  app.get("/api/threads/:id/messages", (c) => {
    try {
      return c.json({ messages: listChatMessages(c.req.param("id"), root) });
    } catch (err) {
      throw mapDomainError(err);
    }
  });
  app.get("/api/threads/:id/files", (c) => {
    try {
      const thread = getChatThread(c.req.param("id"), root);
      return c.json({ files: listChatFiles(thread.repo_root, thread.cwd, turns.touchedFiles(thread.id)) });
    } catch (err) {
      throw mapDomainError(err);
    }
  });
  app.get("/api/threads/:id/permissions", (c) => {
    try {
      getChatThread(c.req.param("id"), root);
      return c.json({ permissions: turns.pendingPermissions(c.req.param("id")) });
    } catch (err) {
      throw mapDomainError(err);
    }
  });
  app.post("/api/threads/:id/permissions/:requestId", async (c) => {
    const body = await readJsonObject(c, new Set(["action"]));
    if (body.action !== "approve" && body.action !== "deny") throw new ApiError(422, "action must be approve or deny", "invalid_field");
    try {
      const request = turns.decidePermission(c.req.param("id"), c.req.param("requestId"), body.action);
      return c.json({ requestId: request.requestId, action: body.action });
    } catch (err) {
      if (err instanceof Error && (err.name === "PermissionDecisionError" || err.message.includes("Permission request"))) throw new ApiError(409, err.message, "permission_stale");
      throw mapDomainError(err);
    }
  });
  app.get("/api/threads/:id/files/content", (c) => {
    try {
      const thread = getChatThread(c.req.param("id"), root);
      const path = c.req.query("path");
      if (!path) throw new ApiError(422, "path is required", "missing_query");
      return c.json({ file: readChatFile(thread.cwd, path) });
    } catch (err) {
      throw mapDomainError(err);
    }
  });
  app.get("/api/threads/:id/attachments", (c) => {
    try { return c.json({ attachments: listChatAttachments(c.req.param("id"), root) }); }
    catch (err) { throw mapDomainError(err); }
  });
  app.get("/api/threads/:id/attachments/:attachmentId", (c) => {
    try {
      const { attachment, bytes } = readChatAttachment(c.req.param("id"), c.req.param("attachmentId"), root);
      return new Response(bytes, { headers: { "Content-Type": attachment.mime_type, "Content-Length": String(bytes.byteLength), "Cache-Control": "private, max-age=31536000, immutable" } });
    } catch (err) { throw mapDomainError(err); }
  });
  app.post("/api/threads/:id/attachments", async (c) => {
    const contentLength = Number(c.req.header("content-length") ?? "0");
    if (contentLength > MAX_ATTACHMENT_BYTES + 256 * 1024) throw new ApiError(422, "Upload exceeds the 10 MiB image limit", "attachment_too_large");
    try {
      const body = await c.req.parseBody({ all: false });
      const file = body.file;
      if (!(file instanceof File)) throw new ApiError(422, "A multipart image field named file is required", "missing_file");
      if (file.size > MAX_ATTACHMENT_BYTES) throw new ChatAttachmentError("Image must be between 1 byte and 10 MiB.", "attachment_too_large");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const attachment = createChatAttachment(c.req.param("id"), { type: file.type, name: file.name, size: file.size, bytes }, root);
      return c.json({ attachment }, 201);
    } catch (err) { throw mapDomainError(err); }
  });
  app.post("/api/threads/:id/messages", async (c) => {
    const body = await readJsonObject(c, new Set(["role", "content"]));
    if (body.role !== "user" && body.role !== "assistant") throw new ApiError(422, "role must be user or assistant", "invalid_field");
    if (body.content === undefined) throw new ApiError(422, "content is required", "missing_field");
    const content = assertString(body.content, "content");
    if (!content.trim()) throw new ApiError(422, "content must not be empty", "invalid_field");
    try {
      const threadId = c.req.param("id");
      const message = appendChatMessage(threadId, body.role, content, root);
      if (bus) {
        publishThreadMessage(bus, threadId, message);
        publishThreadUpdated(bus, getChatThread(threadId, root));
      }
      return c.json({ message }, 201);
    } catch (err) {
      throw mapDomainError(err);
    }
  });
  app.post("/api/threads/:id/send", async (c) => {
    const body = await readJsonObject(c, new Set(["content", "attachment_ids"]));
    if (body.content === undefined) throw new ApiError(422, "content is required", "missing_field");
    const content = assertString(body.content, "content");
    if (!content.trim()) throw new ApiError(422, "content must not be empty", "invalid_field");
    if (body.attachment_ids !== undefined && (!Array.isArray(body.attachment_ids) || body.attachment_ids.some((id) => typeof id !== "string"))) throw new ApiError(422, "attachment_ids must be an array of strings", "invalid_field");
    try {
      const result = await turns.send(c.req.param("id"), content, body.attachment_ids as string[] | undefined);
      return c.json(result, 201);
    } catch (err) {
      throw mapDomainError(err);
    }
  });
  app.post("/api/threads/:id/cancel", async (c) => {
    try {
      await turns.cancel(c.req.param("id"));
      return c.json({ cancelled: true });
    } catch (err) {
      throw mapDomainError(err);
    }
  });
}

function listSessionEventsForThread(threadId: string, root?: string) {
  return listSessionsForOwner("thread", threadId, root).flatMap((session) => listSessionEvents(session.id, root));
}

function registerTaskRoutes(
  app: Hono,
  root: string | undefined,
  worktreeRoot: string | undefined,
  bus: EventBus | undefined,
  machineDir?: string,
): void {
  const makeManager = (): WorktreeManager =>
    (() => {
      const selectedRoot = root ?? repositoryRoot();
      if (!selectedRoot) throw new ApiError(409, "Select a repository before using tasks", "repository_not_selected");
      return worktreeRoot !== undefined
        ? new WorktreeManager(selectedRoot, { worktreeRoot })
        : new WorktreeManager(selectedRoot);
    })();
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
    const body = await readJsonObject(c, new Set(["title", "spec_markdown", "workflow_profile_id", "repository_id"]));
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
      const repository = getSelectedRepository(machineDir);
      const repositoryId = typeof body.repository_id === "string" ? body.repository_id : repository?.id;
      const profileId = typeof body.workflow_profile_id === "string" ? body.workflow_profile_id : undefined;
      if (profileId && (!repositoryId || !getWorkflowProfile(repositoryId, profileId, machineDir))) throw new ApiError(422, "workflow profile is not owned by the selected repository", "workflow_profile_invalid");
      const task = createTask({ slug, title: titleStr, specMarkdown, repositoryId, workflowProfileId: profileId }, root);
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
      freezeTask(slug, root, makeManager());
      return c.json({ task: taskDetail(task) });
    } catch (err) {
      throw mapDomainError(err);
    }
  });

  app.get("/api/tasks/:slug/diff", (c) => {
    const slug = c.req.param("slug");
    try {
      const task = getTask(slug, root);
      if (task.status !== "review") {
        throw new ApiError(409, "task is not in review state", "not_review");
      }
      const result = makeManager().diffForSlug(slug);
      return c.json({ diff: result.diff, stats: result.stats });
    } catch (err) {
      throw mapDomainError(err);
    }
  });

  app.post("/api/tasks/:slug/merge", async (c) => {
    const slug = c.req.param("slug");
    const body = await readJsonObject(c, new Set<string>());
    void body;
    try {
      const task = getTask(slug, root);
      if (task.status !== "review") {
        throw new ApiError(409, "task is not in review state", "not_review");
      }
      const manager = makeManager();
      if (manager.resolveTaskBranch(slug) === undefined) {
        throw new ApiError(409, "no worktree for task", "no_worktree");
      }
      const { commitSha } = manager.mergeTaskBranch(slug);
      // Cleanup first; only mark done once merge + cleanup have fully completed
      // (ADR-016 Decision 5). A cleanup failure surfaces as an error without
      // marking Done.
      manager.destroy(slug);
      const from = task.status;
      const done = transitionTask(slug, "done", root);
      if (bus) publishTaskTransitioned(bus, taskPayload(done), from, "done");
      return c.json({ merged: true, commitSha, task: taskDetail(done) });
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

interface SpecMessageFields {
  id: number;
  task_id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

function specMessageFields(msg: SpecMessage): SpecMessageFields {
  return {
    id: msg.id,
    task_id: msg.task_id,
    role: msg.role,
    content: msg.content,
    created_at: msg.created_at,
  };
}

function registerSpecRoutes(
  app: Hono,
  root: string | undefined,
  bus: EventBus | undefined,
  specAgent: Agent | undefined,
  machineDir?: string,
): void {
  const ensureBus = (bus: EventBus | undefined): EventBus => {
    if (!bus) throw new ApiError(500, "event bus not configured", "internal_error");
    return bus;
  };

  app.get("/api/tasks/:slug/spec-messages", (c) => {
    const slug = c.req.param("slug");
    try {
      const messages = listSpecMessages(slug, root).map(specMessageFields);
      return c.json({ messages });
    } catch (err) {
      throw mapDomainError(err);
    }
  });

  app.post("/api/tasks/:slug/spec-messages", async (c) => {
    const slug = c.req.param("slug");
    const body = await readJsonObject(c, new Set(["content"]));
    const content = body.content;
    if (content === undefined) {
      throw new ApiError(422, "content is required", "missing_field");
    }
    const contentStr = assertString(content, "content");
    if (contentStr.trim().length === 0) {
      throw new ApiError(422, "content must not be empty", "invalid_field");
    }
    try {
      const busLocal = ensureBus(bus);
      // Pre-flight: only backlog tasks accept spec chat.
      const fromTask = getTask(slug, root);
      if (fromTask.status !== "backlog") {
        throw new SpecChatClosedError(slug, fromTask.status);
      }
      const promptEvents = await runSpecAuthorTurn(slug, contentStr, {
        root,
        agent: specAgent,
        machineDir,
      });
      publishSpecMessage(busLocal, slug, promptEvents.userMessage);
      publishSpecMessage(busLocal, slug, promptEvents.assistantMessage);
      return c.json(
        {
          userMessage: specMessageFields(promptEvents.userMessage),
          assistantMessage: specMessageFields(promptEvents.assistantMessage),
        },
        201,
      );
    } catch (err) {
      throw mapDomainError(err);
    }
  });

  app.get("/api/tasks/:slug/spec-author-sessions", (c) => {
    try { const task = getTask(c.req.param("slug"), root); return c.json({ sessions: listSpecAuthorSessions(task.id, root).map((session) => ({ ...session, operations: listSpecAuthorOperations(session.id, root) })) }); }
    catch (err) { throw mapDomainError(err); }
  });

  app.post("/api/tasks/:slug/spec", async (c) => {
    const slug = c.req.param("slug");
    const body = await readJsonObject(c, new Set(["spec_markdown"]));
    const specRaw = body.spec_markdown;
    if (specRaw === undefined) {
      throw new ApiError(422, "spec_markdown is required", "missing_field");
    }
    const specStr = assertString(specRaw, "spec_markdown");
    if (specStr.trim().length === 0) {
      throw new ApiError(422, "spec_markdown must not be empty", "invalid_field");
    }
    try {
      const task = getTask(slug, root);
      if (task.status !== "backlog") {
        throw new SpecChatClosedError(slug, task.status);
      }
      const updated = setSpecMarkdown(slug, specStr, root);
      if (bus) publishTaskUpdated(bus, taskPayload(updated));
      return c.json({ task: taskDetail(updated) });
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
  const root = options.root;

  const { host, port } = resolveDaemonBind(
    { host: options.host, port: options.port },
    options.config,
  );
  const password = options.uiPassword ?? options.config?.daemon?.uiPassword ?? process.env.MARSHAL_UI_PASSWORD;
  if (!isLoopbackHost(host) && !password) {
    throw new Error(
      "LAN access requires a UI password.\n\nProvide one when starting Marshal:\n  marshal start --lan --password <password>\n\nAlternatively, set MARSHAL_UI_PASSWORD or configure daemon.uiPassword.\nFor local-only access, run:\n  marshal start",
    );
  }
  const auth = new AuthService({ password, secureCookies: false });
  const version = options.version ?? readVersion();
  const bus = options.bus ?? new EventBus();
  const attachWs = options.attachWebSockets ?? true;

  const trustedProxy = options.trustedProxy ?? options.config?.daemon?.trustedProxy ?? false;
  const app = buildApp(version, { root, bus, webDir: options.webDir, auth, trustedProxy, machineDir: options.machineDir });
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
    wsHandle = attachWebSocket(server as HttpServer, bus, () => ({
       tasks: (root ?? repositoryRoot()) ? listTasks(root ?? repositoryRoot()).map(taskCard) : [],
       threads: (root ?? repositoryRoot()) ? listChatThreads(root ?? repositoryRoot()) : [],
    }), {
      path: "/ws",
      authenticate: (req) => auth.isAuthenticated(req.headers.cookie),
      allowedOrigins: options.trustedOrigins ?? options.config?.daemon?.trustedOrigins,
    });
  }

  const portFile = portFilePath();
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
