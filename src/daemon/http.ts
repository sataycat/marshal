import { Hono, type Context } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import type { Server as HttpServer } from "node:http";
import {
  existsSync,
  chmodSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  rmSync,
  readdirSync,
} from "node:fs";
import type { IncomingMessage } from "node:http";
import { basename, extname, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { cwd } from "node:process";
import { fileURLToPath } from "node:url";
import { logger } from "../logger.js";
import { getGlobalDir } from "./config.js";
import {
  createStorageTemporaryDirectory,
  ensureStorageLayout,
  storageLayout,
  STORAGE_FILE_MODE,
} from "../storage/layout.js";
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
import { runSpecAuthorTurn, resubmitSpecAuthorTurn, SpecChatClosedError } from "./spec-chat.js";
import { listSpecMessages, type SpecMessage } from "../tasks/spec-store.js";
import { publishSpecMessage } from "./bus.js";
import type { Agent } from "../agent/types.js";
import { MissingAgentIdError } from "../worktree/config.js";
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
import {
  publishThreadCreated,
  publishThreadDeleted,
  publishThreadMessage,
  publishThreadUpdated,
} from "./bus.js";
import { ChatAgentUnavailableError, ChatTurnBusyError, ChatTurnRunner } from "./chat-turn.js";
import {
  ChatFileTooLargeError,
  InvalidChatPathError,
  listChatFiles,
  readChatFile,
} from "../chat/files.js";
import {
  ChatAttachmentError,
  createChatAttachment,
  listChatAttachments,
  MAX_ATTACHMENT_BYTES,
  readChatAttachment,
} from "../chat/attachments.js";
import { AuthService } from "./auth.js";
import {
  getRepository,
  getSelectedRepository,
  listRepositories,
  registerRepository,
  removeRepository,
  selectRepository,
  repositoryRoot,
  RepositoryError,
} from "../repositories/store.js";
import { resolveRepositoryContext, RepositoryContextError } from "../repositories/context.js";
import { fetchRegistrySnapshot } from "../registry/fetch.js";
import {
  beginRegistryRefresh,
  completeRegistryRefresh,
  failRegistryRefresh,
  getRegistryCatalog,
} from "../registry/store.js";
import { PUBLIC_REGISTRY_URL, type RegistryAgent } from "../registry/types.js";
import {
  beginAgentAuthentication,
  finishAgentAuthentication,
  getAgentAuthenticationOperation,
  getInstalledAgent,
  getLatestAgentAuthenticationOperation,
  interruptActiveAgentAuthentications,
  listInstalledAgents,
  listInstallationOperations,
  getInstallationOperation,
  getInstallationByIdentity,
  removeInstalledAgent,
  executeAgentRemoval,
  getAgentRemovalOperation,
  listAgentRemovalOperations,
  setDefaultInstalledAgent,
  getDefaultInstalledAgent,
} from "../agents/store.js";
import { activateInstalledAgent } from "../agents/activation.js";
import {
  cancelInstallationOperation,
  installationOperation,
  installCandidate,
  startInstallation,
} from "../installations/installer.js";
import { authenticateAgent } from "../acp/authenticate.js";
import { bindAgentCredential } from "../agents/credentials.js";
import { launchWithResolvedEnvironment } from "../agents/launch-environment.js";
import {
  StructuredAcpFailureError,
  structuredAcpError,
  type StructuredAcpError,
} from "../acp/errors.js";
import { TerminalAuthManager } from "../acp/terminal-auth.js";
import { listSessionEvents, listSessionsForOwner } from "../acp/supervisor-store.js";
import { randomUUID } from "node:crypto";
import { reconcileThreadPermissions } from "../acp/permission-store.js";

function fuzzyDirectoryScore(name: string, query: string): number | null {
  if (!query) return 0;
  const candidate = name.toLowerCase();
  let cursor = 0;
  let score = 0;
  let previous = -1;
  for (const character of query) {
    const index = candidate.indexOf(character, cursor);
    if (index === -1) return null;
    score += index === previous + 1 ? 0 : index + 1;
    previous = index;
    cursor = index + 1;
  }
  return score + (candidate.length - query.length) * 0.01;
}
import {
  deleteWorkflowProfile,
  getWorkflowProfile,
  listWorkflowProfiles,
  saveWorkflowProfile,
  WorkflowValidationError,
  type WorkflowProfileInput,
} from "../workflows/store.js";
import { historicalProvenance } from "../agents/provenance.js";
import { listSpecAuthorSessions, listSpecAuthorOperations } from "../tasks/author-store.js";

const authenticationControllers = new Map<string, AbortController>();

export { DEFAULT_DAEMON_HOST, DEFAULT_DAEMON_PORT };

export interface HttpServerOptions {
  root?: string;
  repositoryId?: string;
  host?: string;
  port?: number;
  version?: string;
  config?: GlobalConfig;
  bus?: EventBus;
  attachWebSockets?: boolean;
  webDir?: string;
  webUrl?: string;
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

export function portFilePath(machineDir = getGlobalDir()): string {
  return storageLayout(machineDir).daemonPortPath;
}

export interface BuildAppOptions {
  root?: string;
  repositoryId?: string;
  worktreeRoot?: string;
  bus?: EventBus;
  webDir?: string;
  webUrl?: string;
  specAgent?: Agent;
  chatAgent?: Agent;
  auth?: AuthService;
  trustedProxy?: boolean;
  machineDir?: string;
  terminalAuth?: TerminalAuthManager;
}

function resolveConfiguredRepositoryId(
  root: string | undefined,
  repositoryId: string | undefined,
  machineDir?: string,
): string | undefined {
  if (repositoryId) {
    resolveRepositoryContext(repositoryId, machineDir);
    return repositoryId;
  }
  if (!root) return undefined;
  const checkoutPath = resolve(root);
  const existing = listRepositories(machineDir).find((repository) => resolve(repository.path) === checkoutPath);
  if (existing) return existing.id;
  // Directly embedded app instances are an existing development/test seam.
  // Materialize that checkout as a registered resource before any scoped
  // store can open it; the store itself still receives only the ID.
  return registerRepository(checkoutPath, machineDir).id;
}

export function defaultWebDistDir(): string {
  const __dirname = fileURLToPath(new URL(".", import.meta.url));
  return resolve(__dirname, "../../web/dist");
}

export function buildApp(version: string, options: BuildAppOptions = {}): Hono {
  const root = options.root;
  const configuredRepositoryId = resolveConfiguredRepositoryId(root, options.repositoryId, options.machineDir);
  const bus = options.bus;
  const webDir = options.webDir ?? defaultWebDistDir();
  const app = new Hono();
  const auth = options.auth;
  if (auth) {
    app.use("/api/*", auth.middleware);
    app.get("/api/auth/status", (c) =>
      c.json({
        enabled: auth.enabled,
        authenticated: auth.isAuthenticated(c.req.header("Cookie")),
      }),
    );
    app.post("/api/auth/login", async (c) => {
      const body = await readJsonObject(c, new Set(["password"]));
      if (typeof body.password !== "string")
        throw new ApiError(422, "password is required", "missing_field");
      const result = auth.login(body.password, authClientKey(c, options.trustedProxy));
      if (result.retryAfter !== undefined) {
        return new Response(
          JSON.stringify({ error: "Too many failed login attempts", code: "rate_limited" }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": String(result.retryAfter),
            },
          },
        );
      }
      if (!result.token) return c.json({ authenticated: true });
      return c.json({ authenticated: true }, 200, {
        "Set-Cookie": auth.cookie(
          result.token,
          undefined,
          isSecureRequest(c, options.trustedProxy),
        ),
      });
    });
    app.post("/api/auth/logout", (c) => {
      auth.logout(c.req.header("Cookie"));
      return c.json({ authenticated: false }, 200, {
        "Set-Cookie": auth.clearCookie(isSecureRequest(c, options.trustedProxy)),
      });
    });
  }
  app.get("/api/health", (c) => c.json({ status: "ok", version }));
  registerDiagnosticsRoute(app, options.machineDir, root, version);
  registerRepositoryRoutes(app, options.machineDir);
  registerRegistryRoutes(app, options.machineDir);
  registerAgentRoutes(app, options.machineDir, bus, options.terminalAuth);
  registerWorkflowProfileRoutes(app, options.machineDir);
  registerTaskRoutes(app, root, options.worktreeRoot, bus, options.machineDir, configuredRepositoryId);
  registerRunRoutes(app, root, options.machineDir, configuredRepositoryId);
  registerSpecRoutes(app, root, bus, options.specAgent, options.machineDir, configuredRepositoryId);
  registerChatRoutes(app, root, bus, options.chatAgent, options.machineDir, configuredRepositoryId);
  registerStaticRoutes(app, webDir, options.webUrl);
  app.notFound((c) => spaNotFound(c, webDir, options.webUrl));
  app.onError((err, c) => {
    const mapped =
      err instanceof ApiError || err instanceof StructuredAcpFailureError
        ? mapDomainError(err)
        : null;
    if (mapped) {
      const body: { error: string; code?: string; failure?: StructuredAcpError } = {
        error: mapped.message,
      };
      if (mapped.code !== undefined) body.code = mapped.code;
      if (mapped.failure) body.failure = mapped.failure;
      return c.json(body, mapped.status);
    }
    logger.error({ err }, "Unhandled HTTP error");
    return c.json({ error: "Internal server error" }, 500);
  });
  return app;
}

type StatusCode = 200 | 201 | 400 | 404 | 409 | 422 | 500 | 502 | 504;

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

function registerStaticRoutes(app: Hono, webDir: string, webUrl?: string): void {
  app.get("/", (c) => (webUrl ? redirectToWebApp(c, webUrl) : serveSpaIndex(c, webDir)));
  app.get("/assets/*", (c) => serveAsset(c, webDir));
}

function redirectToWebApp(c: Context, webUrl: string): Response {
  const target = new URL(c.req.url);
  const destination = new URL(target.pathname + target.search, webUrl);
  return c.redirect(destination.toString(), 307);
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

function spaNotFound(c: Context, webDir: string, webUrl?: string): Response {
  const path = c.req.path;
  if (path === "/api/health" || path.startsWith("/api/") || path.startsWith("/assets/")) {
    return c.json({ error: "Not found" }, 404);
  }
  if (webUrl) return redirectToWebApp(c, webUrl);
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
    readonly failure?: StructuredAcpError,
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
  return { ...taskCard(task), repositoryId: task.repository_id ?? null };
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
  if (err instanceof StructuredAcpFailureError) {
    const failure = err.failure;
    if (failure.kind === "agent_internal_error" && failure.protocol_code === null) {
      logger.error({ err }, "Unexpected error in task HTTP handler");
      return new ApiError(500, "Internal server error", "internal_error");
    }
    const status: StatusCode =
      failure.kind === "resource_not_found"
        ? 404
        : failure.kind === "timeout"
          ? 504
          : failure.kind === "agent_internal_error" || failure.kind === "process_start_failed"
            ? 502
            : 409;
    return new ApiError(status, failure.message, failure.kind, failure);
  }
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
  if (err instanceof RepositoryError)
    return new ApiError(err.code === "duplicate_path" ? 409 : 422, err.message, err.code);
  if (err instanceof RepositoryContextError)
    return new ApiError(404, err.message, err.code);
  if (err instanceof WorkflowValidationError)
    return new ApiError(422, err.message, "workflow_profile_invalid");
  logger.error({ err }, "Unexpected error in task HTTP handler");
  return new ApiError(500, "Internal server error", "internal_error");
}

function workflowInput(body: Record<string, unknown>): WorkflowProfileInput {
  const assignments = body.assignments;
  if (!Array.isArray(assignments))
    throw new ApiError(422, "assignments must be an array", "invalid_field");
  return {
    name: assertString(body.name, "name"),
    permission_policy: assertString(
      body.permission_policy,
      "permission_policy",
    ) as WorkflowProfileInput["permission_policy"],
    unattended_authorized: body.unattended_authorized === true,
    timeout_ms: typeof body.timeout_ms === "number" ? body.timeout_ms : Number.NaN,
    max_retries: typeof body.max_retries === "number" ? body.max_retries : Number.NaN,
    verification_commands: Array.isArray(body.verification_commands)
      ? body.verification_commands.map((value) => assertString(value, "verification_commands"))
      : [],
    require_decorrelated_builder_validator: body.require_decorrelated_builder_validator === true,
    assignments: assignments.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new ApiError(422, "assignments must contain objects", "invalid_field");
      const item = value as Record<string, unknown>;
      return {
        role: assertString(
          item.role,
          "assignment.role",
        ) as WorkflowProfileInput["assignments"][number]["role"],
        agent_id: assertString(item.agent_id, "assignment.agent_id"),
        agent_version: assertString(item.agent_version, "assignment.agent_version"),
        model: item.model == null ? null : assertString(item.model, "assignment.model"),
        mode: item.mode == null ? null : assertString(item.mode, "assignment.mode"),
      };
    }),
  };
}

function registerWorkflowProfileRoutes(app: Hono, machineDir?: string): void {
  const fields = new Set([
    "name",
    "permission_policy",
    "unattended_authorized",
    "timeout_ms",
    "max_retries",
    "verification_commands",
    "require_decorrelated_builder_validator",
    "assignments",
  ]);
  app.get("/api/repositories/:repositoryId/workflow-profiles", (c) =>
    c.json({ profiles: listWorkflowProfiles(c.req.param("repositoryId"), machineDir) }),
  );
  app.get("/api/repositories/:repositoryId/workflow-profiles/:id", (c) => {
    const found = getWorkflowProfile(c.req.param("repositoryId"), c.req.param("id"), machineDir);
    if (!found) throw new ApiError(404, "Workflow profile not found", "workflow_profile_not_found");
    return c.json({ profile: found });
  });
  app.post("/api/repositories/:repositoryId/workflow-profiles", async (c) => {
    const body = await readJsonObject(c, new Set([...fields, "id"]));
    try {
      return c.json(
        {
          profile: saveWorkflowProfile(
            c.req.param("repositoryId"),
            workflowInput(body),
            typeof body.id === "string"
              ? (body.id as `${string}-${string}-${string}-${string}-${string}`)
              : undefined,
            machineDir,
          ),
        },
        201,
      );
    } catch (error) {
      throw mapDomainError(error);
    }
  });
  app.put("/api/repositories/:repositoryId/workflow-profiles/:id", async (c) => {
    const body = await readJsonObject(c, fields);
    try {
      return c.json({
        profile: saveWorkflowProfile(
          c.req.param("repositoryId"),
          workflowInput(body),
          c.req.param("id") as `${string}-${string}-${string}-${string}-${string}`,
          machineDir,
        ),
      });
    } catch (error) {
      throw mapDomainError(error);
    }
  });
  app.delete("/api/repositories/:repositoryId/workflow-profiles/:id", (c) => {
    if (!deleteWorkflowProfile(c.req.param("repositoryId"), c.req.param("id"), machineDir))
      throw new ApiError(404, "Workflow profile not found", "workflow_profile_not_found");
    return c.json({ deleted: true });
  });
}

function registerRepositoryRoutes(app: Hono, machineDir?: string): void {
  app.get("/api/repositories", (c) =>
    c.json({
      repositories: listRepositories(machineDir),
      selected_repository_id: getSelectedRepository(machineDir)?.id ?? null,
    }),
  );
  app.get("/api/repositories/selected", (c) =>
    c.json({ repository: getSelectedRepository(machineDir) ?? null }),
  );
  app.get("/api/repositories/directories", (c) => {
    const requested = c.req.query("path")?.trim() || homedir();
    const parent = resolve(requested.replace(/^~/, homedir()));
    if (!existsSync(parent) || !statSync(parent).isDirectory())
      throw new ApiError(422, "Directory does not exist", "invalid_path");
    const query = c.req.query("q")?.trim().toLowerCase() ?? "";
    const directories = readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => ({
        name: entry.name,
        path: resolve(parent, entry.name),
        is_git: existsSync(resolve(parent, entry.name, ".git")),
      }))
      .map((entry) => ({ ...entry, fuzzy_score: fuzzyDirectoryScore(entry.name, query) }))
      .filter((entry) => entry.fuzzy_score !== null)
      .sort(
        (a, b) =>
          a.fuzzy_score! - b.fuzzy_score! ||
          Number(b.is_git) - Number(a.is_git) ||
          a.name.localeCompare(b.name),
      )
      .slice(0, 30);
    return c.json({
      path: parent,
      display_path: parent === homedir() ? "~" : parent,
      directories: directories.map(({ fuzzy_score: _score, ...directory }) => directory),
    });
  });
  app.get("/api/repositories/:id", (c) => {
    const repository = getRepository(c.req.param("id"), machineDir);
    if (!repository) throw new ApiError(404, "Repository not found", "repository_not_found");
    return c.json({ repository });
  });
  app.post("/api/repositories", async (c) => {
    const body = await readJsonObject(c, new Set(["path"]));
    if (body.path === undefined) throw new ApiError(422, "path is required", "missing_field");
    try {
      return c.json(
        { repository: registerRepository(assertString(body.path, "path"), machineDir) },
        201,
      );
    } catch (err) {
      throw mapDomainError(err);
    }
  });
  app.post("/api/repositories/:id/select", (c) => {
    try {
      return c.json({ repository: selectRepository(c.req.param("id"), machineDir) });
    } catch (err) {
      if (err instanceof Error && /not found/.test(err.message))
        throw new ApiError(404, err.message, "repository_not_found");
      throw mapDomainError(err);
    }
  });
  app.delete("/api/repositories/:id", (c) => {
    if (!removeRepository(c.req.param("id"), machineDir))
      throw new ApiError(404, "Repository not found", "repository_not_found");
    return c.json({ deleted: true });
  });
}

function registerDiagnosticsRoute(
  app: Hono,
  machineDir: string | undefined,
  root: string | undefined,
  version: string,
): void {
  app.get("/api/diagnostics", (c) => {
    const repositories = listRepositories(machineDir);
    const selected = getSelectedRepository(machineDir);
    const catalog = getRegistryCatalog(machineDir);
    const agents = listInstalledAgents(machineDir);
    const issues: Array<{
      code: string;
      message: string;
      action: string;
      severity: "error" | "warning";
    }> = [];
    if (!selected)
      issues.push({
        code: "REPOSITORY_NOT_SELECTED",
        message: "No repository is selected.",
        action: "Register and select a git repository in the browser.",
        severity: "warning",
      });
    if (catalog.refresh?.status === "failed")
      issues.push({
        code: "REGISTRY_REFRESH_FAILED",
        message: catalog.refresh.error ?? "The registry refresh failed.",
        action:
          "Check network access and refresh the catalog; the last valid snapshot remains usable.",
        severity: "warning",
      });
    if (!catalog.snapshot)
      issues.push({
        code: "REGISTRY_UNAVAILABLE",
        message: "No validated ACP Registry snapshot is available.",
        action: "Open Agents and refresh the catalog.",
        severity: "warning",
      });
    for (const agent of agents) {
      const activation = getInstallationByIdentity(
        agent.id,
        agent.version,
        agent.distribution,
        agent.installation_id,
        machineDir,
      );
      if (agent.status === "failed")
        issues.push({
          code: "INSTALLATION_FAILED",
          message: `${agent.id}@${agent.version}: ${agent.failure ?? "installation failed"}`,
          action: "Retry or remove the failed installation from Agents.",
          severity: "error",
        });
      if (agent.readiness_status === "failed")
        issues.push({
          code: activation?.activation_error_code?.toUpperCase() ?? "ACP_READINESS_FAILED",
          message: `${agent.id}@${agent.version}: ${agent.readiness_error ?? "readiness probe failed"}`,
          action:
            activation?.activation_diagnostic?.action ??
            "Retry the readiness check after reviewing the installation and authentication state.",
          severity: "error",
        });
      if (agent.readiness_status === "authentication_required")
        issues.push({
          code: "AGENT_AUTHENTICATION_REQUIRED",
          message: `${agent.id}@${agent.version} requires authentication.`,
          action: "Complete the advertised authentication flow in Agents.",
          severity: "warning",
        });
    }
    return c.json({
      daemon: { status: "ok", version, host: c.req.header("host") ?? null },
      repository: {
        selected: selected ?? null,
        registered_count: repositories.length,
        root: root ?? null,
      },
      registry: { snapshot: catalog.snapshot, refresh: catalog.refresh },
      agents,
      issues,
    });
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
    const agents = (catalog.snapshot?.agents ?? [])
      .filter(
        (agent) =>
          !query ||
          [agent.id, agent.name, agent.description].some((field) =>
            field.toLowerCase().includes(query),
          ),
      )
      .map(registryAgent);
    return c.json({
      agents,
      snapshot: catalog.snapshot,
      refresh: catalog.refresh,
      source: catalog.snapshot?.source ?? PUBLIC_REGISTRY_URL,
    });
  });
  app.get("/api/registry/agents/:id", (c) => {
    const catalog = getRegistryCatalog(machineDir);
    const agent = catalog.snapshot?.agents.find((entry) => entry.id === c.req.param("id"));
    if (!agent) throw new ApiError(404, "Registry agent not found", "registry_agent_not_found");
    return c.json({
      agent: registryAgent(agent),
      snapshot: catalog.snapshot,
      refresh: catalog.refresh,
    });
  });
  app.post("/api/registry/refresh", (c) => {
    const current = getRegistryCatalog(machineDir).refresh;
    if (current?.status === "running") return c.json({ refresh: current }, 202);
    const refresh = beginRegistryRefresh(machineDir);
    void fetchRegistrySnapshot()
      .then((snapshot) => completeRegistryRefresh(refresh.id, snapshot, machineDir))
      .catch((error: unknown) => {
        failRegistryRefresh(
          refresh.id,
          error instanceof Error ? error.message : "Registry refresh failed",
          machineDir,
        );
      });
    return c.json({ refresh }, 202);
  });
}

function registerAgentRoutes(
  app: Hono,
  machineDir?: string,
  bus?: EventBus,
  terminalAuth?: TerminalAuthManager,
): void {
  app.get("/api/agents", (c) => c.json({ agents: listInstalledAgents(machineDir) }));
  app.post("/api/agents/:id/default", async (c) => {
    const body = await readJsonObject(c, new Set(["installation_id"]));
    const installationId = assertString(body.installation_id, "installation_id");
    try {
      return c.json({
        agent: setDefaultInstalledAgent(c.req.param("id"), installationId, machineDir),
      });
    } catch (error) {
      throw new ApiError(
        409,
        error instanceof Error ? error.message : String(error),
        "agent_not_installed",
      );
    }
  });
  // Static agent routes must register before "/api/agents/:id" so the
  // parameter route cannot shadow them.
  app.get("/api/agents/operations", (c) =>
    c.json({ operations: listInstallationOperations(machineDir) }),
  );
  app.get("/api/agents/removal-operations", (c) =>
    c.json({ operations: listAgentRemovalOperations(machineDir) }),
  );
  app.get("/api/agents/install-candidate", (c) => {
    const agentId = c.req.query("agent_id");
    const version = c.req.query("version");
    if (!agentId || !version)
      throw new ApiError(422, "agent_id and version are required", "missing_query");
    const agent = getRegistryCatalog(machineDir).snapshot?.agents.find(
      (entry) => entry.id === agentId && entry.version === version,
    );
    if (!agent)
      throw new ApiError(404, "Registry agent version not found", "registry_agent_not_found");
    const distribution = c.req.query("distribution");
    if (distribution !== undefined && !["npx", "uvx", "binary"].includes(distribution))
      throw new ApiError(422, "distribution is invalid", "installation_invalid");
    try {
      return c.json({
        candidate: installCandidate(
          agent,
          `${process.platform}-${process.arch}`,
          distribution as "npx" | "uvx" | "binary" | undefined,
        ),
      });
    } catch (error) {
      throw new ApiError(
        422,
        error instanceof Error ? error.message : String(error),
        "installation_invalid",
      );
    }
  });
  app.get("/api/agents/:id", (c) => {
    const version = c.req.query("version");
    const installationId = c.req.query("installation_id");
    if (!version) throw new ApiError(422, "version is required", "missing_query");
    const installed = getInstalledAgent(c.req.param("id"), version, machineDir, installationId);
    if (!installed) throw new ApiError(404, "Installed agent not found", "agent_not_found");
    return c.json({ agent: installed });
  });
  app.post("/api/agents/:id/probe", async (c) => {
    const version = c.req.query("version");
    const installationId = c.req.query("installation_id");
    if (!version) throw new ApiError(422, "version is required", "missing_query");
    const installed = getInstalledAgent(c.req.param("id"), version, machineDir, installationId);
    if (!installed || installed.status !== "installed")
      throw new ApiError(409, "Only an installed agent can be probed", "agent_not_installed");
    const agent = await activateInstalledAgent(
      installed.id,
      installed.version,
      machineDir,
      bus,
      undefined,
      installed.installation_id,
    );
    return c.json({ agent });
  });
  app.get("/api/agents/:id/auth", (c) => {
    const version = c.req.query("version");
    const installationId = c.req.query("installation_id");
    if (!version) throw new ApiError(422, "version is required", "missing_query");
    const installed = getInstalledAgent(c.req.param("id"), version, machineDir, installationId);
    if (!installed) throw new ApiError(404, "Installed agent not found", "agent_not_found");
    return c.json({
      agent: installed,
      authentication:
        getLatestAgentAuthenticationOperation(
          installed.id,
          installed.version,
          machineDir,
          installed.installation_id,
        ) ?? null,
    });
  });
  app.post("/api/agents/:id/auth", async (c) => {
    const version = c.req.query("version");
    const installationId = c.req.query("installation_id");
    if (!version) throw new ApiError(422, "version is required", "missing_query");
    const body = await readJsonObject(c, new Set(["method_id", "values"]));
    const methodId = assertString(body.method_id, "method_id");
    const installed = getInstalledAgent(c.req.param("id"), version, machineDir, installationId);
    if (!installed || installed.status !== "installed")
      throw new ApiError(409, "Only an installed agent can authenticate", "agent_not_installed");
    const method = installed.auth_methods.find((entry) => entry.id === methodId);
    if (!method)
      throw new ApiError(
        422,
        "The selected authentication method is not advertised by this installed agent",
        "auth_method_invalid",
      );
    if (method.type === "env_var") {
      if (body.values === null || typeof body.values !== "object" || Array.isArray(body.values))
        throw new ApiError(422, "values must be an object", "auth_values_invalid");
      const values = body.values as Record<string, unknown>;
      for (const variable of method.vars) {
        const value = values[variable.name];
        if (value === undefined) {
          if (!variable.optional)
            throw new ApiError(422, `${variable.name} is required`, "auth_value_missing");
          continue;
        }
        if (typeof value !== "string")
          throw new ApiError(422, `${variable.name} must be a string`, "auth_value_invalid");
        bindAgentCredential(
          installed.installation_id,
          variable.name,
          value,
          variable.secret,
          machineDir,
        );
      }
      const operation = beginAgentAuthentication(
        {
          id: randomUUID(),
          agent_id: installed.id,
          version: installed.version,
          installation_id: installed.installation_id,
          method_id: method.id,
          method_name: method.name,
          method_type: method.type,
        },
        machineDir,
      );
      try {
        const refreshed = await activateInstalledAgent(
          installed.id,
          installed.version,
          machineDir,
          bus,
          undefined,
          installed.installation_id,
        );
        finishAgentAuthentication(
          operation.id,
          refreshed.readiness_status === "ready" ? "succeeded" : "failed",
          refreshed.readiness_status === "ready"
            ? null
            : (refreshed.readiness_error ?? "Agent is still not ready after saving credentials"),
          machineDir,
          refreshed.readiness_failure,
        );
        return c.json(
          {
            agent: refreshed,
            authentication: getAgentAuthenticationOperation(operation.id, machineDir),
          },
          200,
        );
      } catch (error) {
        const failure = structuredAcpError(error);
        finishAgentAuthentication(operation.id, "failed", failure.message, machineDir, failure);
        throw error;
      }
    }
    if (method.type === "terminal") {
      if (!terminalAuth)
        throw new ApiError(
          500,
          "Terminal authentication is unavailable",
          "terminal_auth_unavailable",
        );
      if (
        !Array.isArray(method.args) ||
        method.args.some((arg) => typeof arg !== "string") ||
        !method.env ||
        Object.values(method.env).some((value) => typeof value !== "string")
      )
        throw new ApiError(
          422,
          "The advertised terminal authentication metadata is invalid",
          "auth_method_invalid",
        );
      const current = getLatestAgentAuthenticationOperation(
        installed.id,
        installed.version,
        machineDir,
        installed.installation_id,
      );
      if (current?.status === "authenticating")
        return c.json(
          { authentication: current, terminal: terminalAuth.snapshot(current.id) },
          202,
        );
      const operation = beginAgentAuthentication(
        {
          id: randomUUID(),
          agent_id: installed.id,
          version: installed.version,
          installation_id: installed.installation_id,
          method_id: method.id,
          method_name: method.name,
          method_type: method.type,
        },
        machineDir,
      );
      return c.json(
        { authentication: operation, terminal: terminalAuth.start(operation, installed, method) },
        202,
      );
    }
    if (method.type !== "agent")
      throw new ApiError(
        422,
        "This advertised authentication method is not supported",
        "auth_method_unsupported",
      );
    const current = getLatestAgentAuthenticationOperation(
      installed.id,
      installed.version,
      machineDir,
      installed.installation_id,
    );
    if (current?.status === "authenticating") return c.json({ authentication: current }, 202);
    const operation = beginAgentAuthentication(
      {
        id: randomUUID(),
        agent_id: installed.id,
        version: installed.version,
        installation_id: installed.installation_id,
        method_id: method.id,
        method_name: method.name,
        method_type: method.type,
      },
      machineDir,
    );
    const controller = new AbortController();
    authenticationControllers.set(operation.id, controller);
    void (async () => {
      const workspace = createStorageTemporaryDirectory(`auth-${operation.id}`, machineDir);
      try {
        await authenticateAgent(
          workspace,
          launchWithResolvedEnvironment(installed, machineDir),
          method.id,
          controller.signal,
        );
        const refreshed = getInstalledAgent(
          installed.id,
          installed.version,
          machineDir,
          installed.installation_id,
        );
        if (!refreshed)
          throw new Error("Installed agent disappeared before the required readiness check");
        const reprobed = await activateInstalledAgent(
          refreshed.id,
          refreshed.version,
          machineDir,
          bus,
          undefined,
          refreshed.installation_id,
        );
        if (reprobed.readiness_status === "ready") {
          finishAgentAuthentication(operation.id, "succeeded", null, machineDir);
        } else {
          const message =
            reprobed.readiness_error ??
            `Fresh readiness check returned ${reprobed.readiness_status}`;
          const failure = reprobed.readiness_failure ?? {
            kind:
              reprobed.readiness_status === "authentication_required"
                ? ("authentication_required" as const)
                : ("agent_internal_error" as const),
            message,
            protocol_code: null,
            data: { readiness_status: reprobed.readiness_status },
          };
          finishAgentAuthentication(operation.id, "failed", message, machineDir, failure);
        }
      } catch (error) {
        const cancelled = controller.signal.aborted;
        const failure = structuredAcpError(error);
        finishAgentAuthentication(
          operation.id,
          cancelled ? "cancelled" : "failed",
          cancelled
            ? "Authentication was cancelled"
            : error instanceof Error
              ? error.message
              : String(error),
          machineDir,
          cancelled
            ? {
                kind: "cancelled",
                message: "Authentication was cancelled",
                protocol_code: null,
                data: null,
              }
            : failure,
        );
      } finally {
        authenticationControllers.delete(operation.id);
        rmSync(workspace, { recursive: true, force: true });
      }
    })();
    return c.json({ authentication: operation }, 202);
  });
  app.get("/api/agents/auth/operations/:id", (c) => {
    const operation = getAgentAuthenticationOperation(c.req.param("id"), machineDir);
    if (!operation)
      throw new ApiError(404, "Authentication operation not found", "operation_not_found");
    return c.json({ authentication: operation });
  });
  app.get("/api/agents/auth/operations/:id/terminal", (c) => {
    const operation = getAgentAuthenticationOperation(c.req.param("id"), machineDir);
    if (!operation)
      throw new ApiError(404, "Authentication operation not found", "operation_not_found");
    if (operation.method_type !== "terminal")
      throw new ApiError(
        409,
        "Authentication operation is not a terminal operation",
        "operation_not_terminal",
      );
    const terminal = terminalAuth?.snapshot(operation.id);
    if (!terminal)
      throw new ApiError(404, "Terminal operation is not retained", "terminal_not_retained");
    return c.json({ terminal });
  });
  app.post("/api/agents/auth/operations/:id/cancel", (c) => {
    const operation = getAgentAuthenticationOperation(c.req.param("id"), machineDir);
    if (!operation)
      throw new ApiError(404, "Authentication operation not found", "operation_not_found");
    if (operation.status === "authenticating" && operation.method_type === "terminal") {
      const cancelled = terminalAuth?.cancel(operation.id);
      if (!cancelled)
        throw new ApiError(
          409,
          "Terminal authentication operation is not running",
          "authentication_not_running",
        );
      return c.json({ authentication: cancelled });
    }
    if (operation.status === "authenticating") authenticationControllers.get(operation.id)?.abort();
    return c.json({ authentication: getAgentAuthenticationOperation(operation.id, machineDir) });
  });
  app.post("/api/agents/install", async (c) => {
    const body = await readJsonObject(
      c,
      new Set(["agent_id", "version", "distribution", "allow_unverified"]),
    );
    const agentId = assertString(body.agent_id, "agent_id");
    const version = assertString(body.version, "version");
    const distribution =
      body.distribution === undefined ? undefined : assertString(body.distribution, "distribution");
    if (distribution !== undefined && !["npx", "uvx", "binary"].includes(distribution))
      throw new ApiError(422, "distribution is invalid", "installation_invalid");
    const catalog = getRegistryCatalog(machineDir);
    const registryAgent = catalog.snapshot?.agents.find(
      (agent) => agent.id === agentId && agent.version === version,
    );
    if (!registryAgent)
      throw new ApiError(404, "Registry agent version not found", "registry_agent_not_found");
    try {
      if (body.allow_unverified !== undefined && typeof body.allow_unverified !== "boolean")
        throw new Error("allow_unverified must be a boolean");
      return c.json(
        {
          operation: await startInstallation(
            registryAgent,
            machineDir,
            undefined,
            distribution as "npx" | "uvx" | "binary" | undefined,
            { allowUnverified: body.allow_unverified === true },
            bus,
          ),
        },
        202,
      );
    } catch (error) {
      throw new ApiError(
        422,
        error instanceof Error ? error.message : String(error),
        "installation_invalid",
      );
    }
  });
  app.post("/api/agents/:id/update", async (c) => {
    const body = await readJsonObject(c, new Set(["version", "distribution", "allow_unverified"]));
    const version = assertString(body.version, "version");
    const distribution =
      body.distribution === undefined ? undefined : assertString(body.distribution, "distribution");
    if (distribution !== undefined && !["npx", "uvx", "binary"].includes(distribution))
      throw new ApiError(422, "distribution is invalid", "installation_invalid");
    const registryAgent = getRegistryCatalog(machineDir).snapshot?.agents.find(
      (agent) => agent.id === c.req.param("id") && agent.version === version,
    );
    if (!registryAgent)
      throw new ApiError(404, "Registry agent version not found", "registry_agent_not_found");
    try {
      if (body.allow_unverified !== undefined && typeof body.allow_unverified !== "boolean")
        throw new Error("allow_unverified must be a boolean");
      return c.json(
        {
          operation: await startInstallation(
            registryAgent,
            machineDir,
            undefined,
            distribution as "npx" | "uvx" | "binary" | undefined,
            { allowUnverified: body.allow_unverified === true },
            bus,
          ),
        },
        202,
      );
    } catch (error) {
      throw new ApiError(
        422,
        error instanceof Error ? error.message : String(error),
        "installation_invalid",
      );
    }
  });
  app.get("/api/agents/operations/:id", (c) => {
    try {
      return c.json({ operation: installationOperation(c.req.param("id"), machineDir) });
    } catch {
      throw new ApiError(404, "Installation operation not found", "operation_not_found");
    }
  });
  app.post("/api/agents/operations/:id/cancel", (c) => {
    try {
      return c.json({ operation: cancelInstallationOperation(c.req.param("id"), machineDir, bus) });
    } catch (error) {
      throw new ApiError(
        409,
        error instanceof Error ? error.message : String(error),
        "installation_cancel_failed",
      );
    }
  });
  app.post("/api/agents/operations/:id/retry", async (c) => {
    const prior = getInstallationOperation(c.req.param("id"), machineDir);
    if (!prior) throw new ApiError(404, "Installation operation not found", "operation_not_found");
    if (prior.status !== "failed" && prior.status !== "interrupted")
      throw new ApiError(
        409,
        "Only failed or interrupted installations can be retried",
        "installation_not_retryable",
      );
    const agent = getRegistryCatalog(machineDir).snapshot?.agents.find(
      (entry) => entry.id === prior.agent_id && entry.version === prior.version,
    );
    if (!agent)
      throw new ApiError(
        409,
        "The registry no longer contains this agent version",
        "registry_agent_not_found",
      );
    const body = await readJsonObject(c, new Set(["allow_unverified"]));
    if (body.allow_unverified !== undefined && typeof body.allow_unverified !== "boolean")
      throw new ApiError(422, "allow_unverified must be a boolean", "invalid_field");
    return c.json(
      {
        operation: await startInstallation(
          agent,
          machineDir,
          undefined,
          prior.distribution,
          { retry: true, allowUnverified: body.allow_unverified === true },
          bus,
        ),
      },
      202,
    );
  });
  app.get("/api/agents/removal-operations/:operationId", (c) => {
    const operation = getAgentRemovalOperation(c.req.param("operationId"), machineDir);
    if (!operation)
      throw new ApiError(404, "Agent removal operation not found", "operation_not_found");
    return c.json({ operation });
  });
  app.post("/api/agents/removal-operations/:operationId/retry", (c) => {
    const operation = getAgentRemovalOperation(c.req.param("operationId"), machineDir);
    if (!operation)
      throw new ApiError(404, "Agent removal operation not found", "operation_not_found");
    return c.json({ operation: executeAgentRemoval(operation.id, machineDir) }, 202);
  });
  app.delete("/api/agents/:id", (c) => {
    const version = c.req.query("version");
    if (!version) throw new ApiError(422, "version is required", "missing_query");
    try {
      const operation = removeInstalledAgent(
        c.req.param("id"),
        version,
        machineDir,
        c.req.query("installation_id"),
      );
      return c.json({ operation }, operation.status === "blocked" ? 409 : 202);
    } catch (error) {
      const code =
        error instanceof Error && "code" in error
          ? String((error as Error & { code?: string }).code)
          : "agent_removal_failed";
      throw new ApiError(
        code === "agent_not_found" ? 404 : 409,
        error instanceof Error ? error.message : String(error),
        code,
      );
    }
  });
}

function registerChatRoutes(
  app: Hono,
  root: string | undefined,
  bus: EventBus | undefined,
  chatAgent?: Agent,
  machineDir?: string,
  configuredRepositoryId?: string,
): void {
  const resolveRequestRepository = (c: Context, explicit?: unknown): string => {
    const requested = typeof explicit === "string" ? explicit : c.req.query("repository_id") ?? c.req.header("x-marshal-repository-id") ?? configuredRepositoryId;
    if (!requested) throw new ApiError(409, "repository_id is required", "repository_required");
    if (explicit !== undefined && typeof explicit !== "string") throw new ApiError(422, "repository_id must be a string", "invalid_field");
    resolveRepositoryContext(requested, machineDir);
    return requested;
  };
  const turnsByRepository = new Map<string, ChatTurnRunner>();
  const turnsFor = (repositoryId: string): ChatTurnRunner => {
    const current = turnsByRepository.get(repositoryId);
    if (current) return current;
    const repository = resolveRepositoryContext(repositoryId, machineDir);
    const created = new ChatTurnRunner({ repositoryId, root: repository.checkoutPath, bus, agent: chatAgent, machineDir });
    turnsByRepository.set(repositoryId, created);
    return created;
  };
  app.get("/api/threads", (c) => {
    const repositoryId = resolveRequestRepository(c);
    return c.json({
      threads: listChatThreads(repositoryId, c.req.query("archived") === "true", machineDir),
    });
  });
  app.post("/api/threads", async (c) => {
    const body = await readJsonObject(
      c,
      new Set(["repository_id", "agent_id", "agent_version", "cwd", "title", "task_slug"]),
    );
    const repositoryId = resolveRequestRepository(c, body.repository_id);
    if (body.agent_id === undefined)
      throw new ApiError(422, "agent_id is required", "missing_field");
    const agentId = assertString(body.agent_id, "agent_id");
    const agentVersion =
      body.agent_version === undefined
        ? getDefaultInstalledAgent(agentId, machineDir)?.version
        : assertString(body.agent_version, "agent_version");
    if (!agentVersion)
      throw new ApiError(
        422,
        "agent_version is required when no default is selected",
        "missing_field",
      );
    if (!agentId.trim()) throw new ApiError(422, "agent_id must not be empty", "invalid_field");
    const installed = getInstalledAgent(agentId, agentVersion, machineDir);
    if (!chatAgent && (!installed || installed.status !== "installed"))
      throw new ApiError(
        409,
        "Only an installed agent can be selected for a session",
        "agent_not_installed",
      );
    if (!chatAgent && installed?.readiness_status !== "ready")
      throw new ApiError(409, `Agent ${agentId}@${agentVersion} is not ready`, "agent_not_ready");
    const thread = createChatThread(
      repositoryId,
      {
        agentId,
        agentVersion,
        cwd: body.cwd === undefined ? undefined : assertString(body.cwd, "cwd"),
        title: body.title === undefined ? undefined : assertString(body.title, "title"),
        taskSlug:
          body.task_slug === undefined ? undefined : assertString(body.task_slug, "task_slug"),
        agentProvenance: historicalProvenance(
          agentId,
          agentVersion,
          installed?.provenance,
          installed?.installation_id,
        ),
      },
      machineDir,
    );
    if (bus) publishThreadCreated(bus, thread);
    return c.json({ thread }, 201);
  });
  app.get("/api/threads/:id", (c) => {
    try {
      const repositoryId = resolveRequestRepository(c);
      const thread = getChatThread(repositoryId, c.req.param("id"), machineDir);
      return c.json({
        thread,
        messages: listChatMessages(repositoryId, thread.id, machineDir),
        attachments: listChatAttachments(repositoryId, thread.id, machineDir),
        events: listSessionEventsForThread(repositoryId, thread.id, machineDir),
      });
    } catch (err) {
      throw mapDomainError(err);
    }
  });
  app.get("/api/threads/:id/events", (c) => {
    try {
      const repositoryId = resolveRequestRepository(c);
      getChatThread(repositoryId, c.req.param("id"), machineDir);
      const sessions = listSessionEventsForThread(repositoryId, c.req.param("id"), machineDir);
      return c.json({ events: sessions });
    } catch (err) {
      throw mapDomainError(err);
    }
  });
  app.post("/api/threads/:id/session", async (c) => {
    try {
      const repositoryId = resolveRequestRepository(c);
      await turnsFor(repositoryId).initializeThread(c.req.param("id"));
      return c.json({ thread: getChatThread(repositoryId, c.req.param("id"), machineDir) });
    } catch (err) {
      throw mapDomainError(err);
    }
  });
  app.post("/api/threads/:id/session/config-options/:configId", async (c) => {
    const body = await readJsonObject(c, new Set(["value"]));
    if (typeof body.value !== "string" && typeof body.value !== "boolean")
      throw new ApiError(422, "value must be a string or boolean", "invalid_field");
    try {
      const repositoryId = resolveRequestRepository(c);
      await turnsFor(repositoryId).setConfigOption(c.req.param("id"), c.req.param("configId"), body.value);
      return c.json({ thread: getChatThread(repositoryId, c.req.param("id"), machineDir) });
    } catch (err) {
      throw mapDomainError(err);
    }
  });
  app.post("/api/threads/:id/session/mode", async (c) => {
    const body = await readJsonObject(c, new Set(["mode_id"]));
    if (body.mode_id === undefined) throw new ApiError(422, "mode_id is required", "missing_field");
    try {
      const repositoryId = resolveRequestRepository(c);
      await turnsFor(repositoryId).setMode(c.req.param("id"), assertString(body.mode_id, "mode_id"));
      return c.json({ thread: getChatThread(repositoryId, c.req.param("id"), machineDir) });
    } catch (err) {
      throw mapDomainError(err);
    }
  });
  app.patch("/api/threads/:id", async (c) => {
    const body = await readJsonObject(
      c,
      new Set(["title", "status", "archived", "pinned", "scratch_markdown"]),
    );
    if (body.title !== undefined && typeof body.title !== "string")
      throw new ApiError(422, "title must be a string", "invalid_field");
    if (
      body.status !== undefined &&
      (typeof body.status !== "string" || !isChatThreadStatus(body.status))
    )
      throw new ApiError(422, "status is invalid", "invalid_field");
    for (const field of ["archived", "pinned"] as const) {
      if (body[field] !== undefined && typeof body[field] !== "boolean")
        throw new ApiError(422, `${field} must be a boolean`, "invalid_field");
    }
    if (body.scratch_markdown !== undefined && typeof body.scratch_markdown !== "string")
      throw new ApiError(422, "scratch_markdown must be a string", "invalid_field");
    try {
      const repositoryId = resolveRequestRepository(c);
      const turns = turnsFor(repositoryId);
      if (body.status === "closed") await turns.closeThread(c.req.param("id"));
      const thread = updateChatThread(
        repositoryId,
        c.req.param("id"),
        {
          title: body.title as string | undefined,
          status: body.status as
            | "active"
            | "authentication_required"
            | "closed"
            | "error"
            | undefined,
          archived: body.archived as boolean | undefined,
          pinned: body.pinned as boolean | undefined,
          scratchMarkdown: body.scratch_markdown as string | undefined,
        },
        machineDir,
      );
      if (bus) publishThreadUpdated(bus, thread);
      return c.json({ thread });
    } catch (err) {
      throw mapDomainError(err);
    }
  });
  app.delete("/api/threads/:id", async (c) => {
    try {
      const repositoryId = resolveRequestRepository(c);
      await turnsFor(repositoryId).closeThread(c.req.param("id"));
      reconcileThreadPermissions(repositoryId, c.req.param("id"), machineDir);
      deleteChatThread(repositoryId, c.req.param("id"), machineDir);
      if (bus) publishThreadDeleted(bus, c.req.param("id"), repositoryId);
      return c.json({ deleted: true });
    } catch (err) {
      throw mapDomainError(err);
    }
  });
  app.get("/api/threads/:id/messages", (c) => {
    try {
      const repositoryId = resolveRequestRepository(c);
      return c.json({ messages: listChatMessages(repositoryId, c.req.param("id"), machineDir) });
    } catch (err) {
      throw mapDomainError(err);
    }
  });
  app.get("/api/threads/:id/files", (c) => {
    try {
      const repositoryId = resolveRequestRepository(c);
      const thread = getChatThread(repositoryId, c.req.param("id"), machineDir);
      return c.json({
        files: listChatFiles(thread.repo_root, thread.cwd, turnsFor(repositoryId).touchedFiles(thread.id)),
      });
    } catch (err) {
      throw mapDomainError(err);
    }
  });
  app.get("/api/threads/:id/permissions", (c) => {
    try {
      const repositoryId = resolveRequestRepository(c);
      getChatThread(repositoryId, c.req.param("id"), machineDir);
      return c.json({ permissions: turnsFor(repositoryId).pendingPermissions(c.req.param("id")) });
    } catch (err) {
      throw mapDomainError(err);
    }
  });
  app.post("/api/threads/:id/permissions/:requestId", async (c) => {
    const body = await readJsonObject(c, new Set(["action"]));
    if (body.action !== "approve" && body.action !== "deny")
      throw new ApiError(422, "action must be approve or deny", "invalid_field");
    try {
      const repositoryId = resolveRequestRepository(c);
      const request = turnsFor(repositoryId).decidePermission(
        c.req.param("id"),
        c.req.param("requestId"),
        body.action,
      );
      return c.json({ requestId: request.requestId, action: body.action });
    } catch (err) {
      if (
        err instanceof Error &&
        (err.name === "PermissionDecisionError" || err.message.includes("Permission request"))
      )
        throw new ApiError(409, err.message, "permission_stale");
      throw mapDomainError(err);
    }
  });
  app.get("/api/threads/:id/files/content", (c) => {
    try {
      const repositoryId = resolveRequestRepository(c);
      const thread = getChatThread(repositoryId, c.req.param("id"), machineDir);
      const path = c.req.query("path");
      if (!path) throw new ApiError(422, "path is required", "missing_query");
      return c.json({ file: readChatFile(thread.cwd, path) });
    } catch (err) {
      throw mapDomainError(err);
    }
  });
  app.get("/api/threads/:id/attachments", (c) => {
    try {
      const repositoryId = resolveRequestRepository(c);
      return c.json({ attachments: listChatAttachments(repositoryId, c.req.param("id"), machineDir) });
    } catch (err) {
      throw mapDomainError(err);
    }
  });
  app.get("/api/threads/:id/attachments/:attachmentId", (c) => {
    try {
      const repositoryId = resolveRequestRepository(c);
      const { attachment, bytes } = readChatAttachment(
        repositoryId,
        c.req.param("id"),
        c.req.param("attachmentId"),
        machineDir,
      );
      return new Response(bytes, {
        headers: {
          "Content-Type": attachment.mime_type,
          "Content-Length": String(bytes.byteLength),
          "Cache-Control": "private, max-age=31536000, immutable",
        },
      });
    } catch (err) {
      throw mapDomainError(err);
    }
  });
  app.post("/api/threads/:id/attachments", async (c) => {
    const contentLength = Number(c.req.header("content-length") ?? "0");
    if (contentLength > MAX_ATTACHMENT_BYTES + 256 * 1024)
      throw new ApiError(422, "Upload exceeds the 10 MiB image limit", "attachment_too_large");
    try {
      const body = await c.req.parseBody({ all: false });
      const file = body.file;
      if (!(file instanceof File))
        throw new ApiError(422, "A multipart image field named file is required", "missing_file");
      if (file.size > MAX_ATTACHMENT_BYTES)
        throw new ChatAttachmentError(
          "Image must be between 1 byte and 10 MiB.",
          "attachment_too_large",
        );
      const bytes = new Uint8Array(await file.arrayBuffer());
      const repositoryId = resolveRequestRepository(c);
      const attachment = createChatAttachment(
        repositoryId,
        c.req.param("id"),
        { type: file.type, name: file.name, size: file.size, bytes },
        machineDir,
      );
      return c.json({ attachment }, 201);
    } catch (err) {
      throw mapDomainError(err);
    }
  });
  app.post("/api/threads/:id/messages", async (c) => {
    const body = await readJsonObject(c, new Set(["role", "content"]));
    if (body.role !== "user" && body.role !== "assistant")
      throw new ApiError(422, "role must be user or assistant", "invalid_field");
    if (body.content === undefined) throw new ApiError(422, "content is required", "missing_field");
    const content = assertString(body.content, "content");
    if (!content.trim()) throw new ApiError(422, "content must not be empty", "invalid_field");
    try {
      const threadId = c.req.param("id");
      const repositoryId = resolveRequestRepository(c);
      const message = appendChatMessage(repositoryId, threadId, body.role, content, [], machineDir);
      if (bus) {
        publishThreadMessage(bus, threadId, message);
        publishThreadUpdated(bus, getChatThread(repositoryId, threadId, machineDir));
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
    if (
      body.attachment_ids !== undefined &&
      (!Array.isArray(body.attachment_ids) ||
        body.attachment_ids.some((id) => typeof id !== "string"))
    )
      throw new ApiError(422, "attachment_ids must be an array of strings", "invalid_field");
    try {
      const repositoryId = resolveRequestRepository(c);
      const result = await turnsFor(repositoryId).send(
        c.req.param("id"),
        content,
        body.attachment_ids as string[] | undefined,
      );
      return c.json(result, 201);
    } catch (err) {
      throw mapDomainError(err);
    }
  });
  app.post("/api/threads/:id/messages/:messageId/resubmit", async (c) => {
    try {
      const repositoryId = resolveRequestRepository(c);
      return c.json(await turnsFor(repositoryId).resubmit(c.req.param("id"), Number(c.req.param("messageId"))), 201);
    } catch (err) {
      throw mapDomainError(err);
    }
  });
  app.post("/api/threads/:id/cancel", async (c) => {
    try {
      const repositoryId = resolveRequestRepository(c);
      await turnsFor(repositoryId).cancel(c.req.param("id"));
      return c.json({ cancelled: true });
    } catch (err) {
      throw mapDomainError(err);
    }
  });
}

function listSessionEventsForThread(repositoryId: string, threadId: string, machineDir?: string) {
  return listSessionsForOwner(repositoryId, "thread", threadId, machineDir).flatMap((session) =>
    listSessionEvents(repositoryId, session.id, machineDir),
  );
}

function registerTaskRoutes(
  app: Hono,
  root: string | undefined,
  worktreeRoot: string | undefined,
  bus: EventBus | undefined,
  machineDir?: string,
  configuredRepositoryId?: string,
): void {
  const resolveFactoryRepository = (c: Context): { id: string; checkoutPath: string } => {
    const id = c.req.query("repository_id") ?? c.req.header("x-marshal-repository-id") ?? configuredRepositoryId;
    if (!id) throw new ApiError(409, "repository_id is required", "repository_required");
    const context = resolveRepositoryContext(id, machineDir);
    return { id, checkoutPath: context.checkoutPath };
  };
  const configuredRoot = root ?? (configuredRepositoryId ? resolveRepositoryContext(configuredRepositoryId, machineDir).checkoutPath : undefined);
  const makeManager = (): WorktreeManager =>
    (() => {
      const selectedRoot = root ?? repositoryRoot(machineDir);
      if (!selectedRoot)
        throw new ApiError(
          409,
          "Select a repository before using tasks",
          "repository_not_selected",
        );
      return worktreeRoot !== undefined
        ? new WorktreeManager(selectedRoot, { worktreeRoot })
        : new WorktreeManager(selectedRoot);
    })();
  app.get("/api/tasks", (c) => {
    const repository = resolveFactoryRepository(c);
    const tasks = listTasks(repository.id, machineDir).map(taskCard);
    return c.json({ tasks });
  });

  app.get("/api/tasks/:slug", (c) => {
    const slug = c.req.param("slug");
    try {
      const repository = resolveFactoryRepository(c);
      const task = getTask(repository.id, slug, machineDir);
      return c.json({ task: taskDetail(task) });
    } catch (err) {
      throw mapDomainError(err);
    }
  });

  app.post("/api/tasks", async (c) => {
    const body = await readJsonObject(
      c,
      new Set(["title", "spec_markdown", "workflow_profile_id", "repository_id"]),
    );
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
      const repository = resolveFactoryRepository(c);
      const repositoryId = repository.id;
      if (body.repository_id !== undefined && body.repository_id !== repositoryId)
        throw new ApiError(409, "repository_id does not match the requested repository", "repository_conflict");
      const slug = generateUniqueSlug(repositoryId, titleStr, machineDir);
      const profileId =
        typeof body.workflow_profile_id === "string" ? body.workflow_profile_id : undefined;
      if (profileId && (!repositoryId || !getWorkflowProfile(repositoryId, profileId, machineDir)))
        throw new ApiError(
          422,
          "workflow profile is not owned by the selected repository",
          "workflow_profile_invalid",
        );
      const task = createTask(
        { slug, title: titleStr, specMarkdown, repositoryId, workflowProfileId: profileId },
        machineDir,
      );
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
      const repository = resolveFactoryRepository(c);
      const fromTask = getTask(repository.id, slug, machineDir);
      const from = fromTask.status;
      const task = transitionTask(repository.id, slug, toStr, machineDir);
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
      const repository = resolveFactoryRepository(c);
      const fromTask = getTask(repository.id, slug, machineDir);
      const from = fromTask.status;
      if (specOverride !== undefined) {
        setSpecMarkdown(repository.id, slug, specOverride, machineDir);
        if (bus) publishTaskUpdated(bus, taskPayload(getTask(repository.id, slug, machineDir)));
      }
      const task = transitionTask(repository.id, slug, "ready", machineDir);
      if (bus) publishTaskTransitioned(bus, taskPayload(task), from, "ready");
      freezeTask(slug, repository.checkoutPath, makeManager());
      return c.json({ task: taskDetail(task) });
    } catch (err) {
      throw mapDomainError(err);
    }
  });

  app.get("/api/tasks/:slug/diff", (c) => {
    const slug = c.req.param("slug");
    try {
      const repository = resolveFactoryRepository(c);
      const task = getTask(repository.id, slug, machineDir);
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
      const repository = resolveFactoryRepository(c);
      const task = getTask(repository.id, slug, machineDir);
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
      const done = transitionTask(repository.id, slug, "done", machineDir);
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
  agent_version: string | undefined;
  capabilities: unknown;
  assignment_config: unknown;
  supervisor_session_id: string | null | undefined;
  operation_id: string | null | undefined;
  verification_status: "pass" | "fail" | null | undefined;
  verification_output: string | null | undefined;
  failure: unknown;
  auth_recovery_resolved_at: string | null | undefined;
  superseded_by_run_id: number | null | undefined;
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
    agent_version: run.agentVersion,
    capabilities: run.capabilities,
    assignment_config: run.assignmentConfig,
    supervisor_session_id: run.supervisorSessionId,
    operation_id: run.operationId,
    verification_status: run.verificationStatus,
    verification_output: run.verificationOutput,
    failure: run.failure,
    auth_recovery_resolved_at: run.authRecoveryResolvedAt,
    superseded_by_run_id: run.supersededByRunId,
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

function registerRunRoutes(app: Hono, root: string | undefined, machineDir?: string, configuredRepositoryId?: string): void {
  app.get("/api/tasks/:slug/runs", (c) => {
    const slug = c.req.param("slug");
    try {
      const repositoryId = c.req.query("repository_id") ?? configuredRepositoryId;
      if (!repositoryId) throw new ApiError(409, "repository_id is required", "repository_required");
      const task = getTask(repositoryId, slug, machineDir);
      const log = new RunLog(repositoryId, machineDir);
      const runs = log.listRunsForTask(task.id).map(runCard);
      return c.json({ runs });
    } catch (err) {
      throw mapDomainError(err);
    }
  });

  app.get("/api/runs/:id", (c) => {
    const runId = parseRunId(c.req.param("id"));
    const repositoryId = c.req.query("repository_id") ?? configuredRepositoryId;
    if (!repositoryId) throw new ApiError(409, "repository_id is required", "repository_required");
    const log = new RunLog(repositoryId, machineDir);
    const run = log.getRun(runId);
    if (run === undefined) throw new ApiError(404, `Run not found: ${runId}`, "run_not_found");
    return c.json({ run: runDetail(run) });
  });
  app.post("/api/runs/:id/recover-authentication", (c) => {
    const runId = parseRunId(c.req.param("id"));
    const repositoryId = c.req.query("repository_id") ?? configuredRepositoryId;
    if (!repositoryId) throw new ApiError(409, "repository_id is required", "repository_required");
    const log = new RunLog(repositoryId, machineDir);
    try {
      const run = log.resolveAuthenticationRequired(runId);
      return c.json({ run: runDetail(run) });
    } catch (err) {
      if (err instanceof RunNotFoundError) throw new ApiError(404, err.message, "run_not_found");
      throw new ApiError(
        409,
        err instanceof Error ? err.message : String(err),
        "run_not_authentication_required",
      );
    }
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
    const repositoryId = c.req.query("repository_id") ?? configuredRepositoryId;
    if (!repositoryId) throw new ApiError(409, "repository_id is required", "repository_required");
    const log = new RunLog(repositoryId, machineDir);
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
  prompt_status: "authentication_required" | null;
  failure: unknown;
}

function specMessageFields(msg: SpecMessage): SpecMessageFields {
  return {
    id: msg.id,
    task_id: msg.task_id,
    role: msg.role,
    content: msg.content,
    created_at: msg.created_at,
    prompt_status: msg.prompt_status ?? null,
    failure: msg.failure ?? null,
  };
}

function registerSpecRoutes(
  app: Hono,
  root: string | undefined,
  bus: EventBus | undefined,
  specAgent: Agent | undefined,
  machineDir?: string,
  configuredRepositoryId?: string,
): void {
  const repositoryFor = (c: Context): string => {
    const id = c.req.query("repository_id") ?? configuredRepositoryId;
    if (!id) throw new ApiError(409, "repository_id is required", "repository_required");
    resolveRepositoryContext(id, machineDir);
    return id;
  };
  const ensureBus = (bus: EventBus | undefined): EventBus => {
    if (!bus) throw new ApiError(500, "event bus not configured", "internal_error");
    return bus;
  };

  app.get("/api/tasks/:slug/spec-messages", (c) => {
    const slug = c.req.param("slug");
    try {
      const repositoryId = repositoryFor(c);
      const messages = listSpecMessages(repositoryId, slug, machineDir).map(specMessageFields);
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
      const repositoryId = repositoryFor(c);
      // Pre-flight: only backlog tasks accept spec chat.
      const fromTask = getTask(repositoryId, slug, machineDir);
      if (fromTask.status !== "backlog") {
        throw new SpecChatClosedError(slug, fromTask.status);
      }
      const promptEvents = await runSpecAuthorTurn(slug, contentStr, {
        root: resolveRepositoryContext(repositoryId, machineDir).checkoutPath,
        repositoryId,
        agent: specAgent,
        machineDir,
      });
      publishSpecMessage(busLocal, slug, promptEvents.userMessage, repositoryId);
      if (promptEvents.assistantMessage)
        publishSpecMessage(busLocal, slug, promptEvents.assistantMessage, repositoryId);
      return c.json(
        {
          userMessage: specMessageFields(promptEvents.userMessage),
          assistantMessage: promptEvents.assistantMessage
            ? specMessageFields(promptEvents.assistantMessage)
            : null,
        },
        201,
      );
    } catch (err) {
      throw mapDomainError(err);
    }
  });
  app.post("/api/tasks/:slug/spec-messages/:messageId/resubmit", async (c) => {
    const messageId = Number(c.req.param("messageId"));
    if (!Number.isInteger(messageId) || messageId <= 0)
      throw new ApiError(400, "message id must be a positive integer", "invalid_message_id");
    try {
      const repositoryId = repositoryFor(c);
      const result = await resubmitSpecAuthorTurn(c.req.param("slug"), messageId, {
        root,
        repositoryId,
        agent: specAgent,
        machineDir,
      });
      const busLocal = ensureBus(bus);
      publishSpecMessage(busLocal, c.req.param("slug"), result.userMessage, repositoryId);
      if (result.assistantMessage)
        publishSpecMessage(busLocal, c.req.param("slug"), result.assistantMessage, repositoryId);
      return c.json(
        {
          userMessage: specMessageFields(result.userMessage),
          assistantMessage: result.assistantMessage
            ? specMessageFields(result.assistantMessage)
            : null,
        },
        201,
      );
    } catch (err) {
      throw mapDomainError(err);
    }
  });

  app.get("/api/tasks/:slug/spec-author-sessions", (c) => {
    try {
      const repositoryId = repositoryFor(c);
      const task = getTask(repositoryId, c.req.param("slug"), machineDir);
      return c.json({
        sessions: listSpecAuthorSessions(repositoryId, task.id, machineDir).map((session) => ({
          ...session,
          operations: listSpecAuthorOperations(repositoryId, session.id, machineDir),
        })),
      });
    } catch (err) {
      throw mapDomainError(err);
    }
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
      const repositoryId = repositoryFor(c);
      const task = getTask(repositoryId, slug, machineDir);
      if (task.status !== "backlog") {
        throw new SpecChatClosedError(slug, task.status);
      }
      const updated = setSpecMarkdown(repositoryId, slug, specStr, machineDir);
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
  const machineDir = options.machineDir ?? getGlobalDir();

  const { host, port } = resolveDaemonBind(
    { host: options.host, port: options.port },
    options.config,
  );
  const password =
    options.uiPassword ?? options.config?.daemon?.uiPassword ?? process.env.MARSHAL_UI_PASSWORD;
  if (!isLoopbackHost(host) && !password) {
    throw new Error(
      "LAN access requires a UI password.\n\nProvide one when starting Marshal:\n  marshal start --lan --password <password>\n\nAlternatively, set MARSHAL_UI_PASSWORD or configure daemon.uiPassword.\nFor local-only access, run:\n  marshal start",
    );
  }
  const auth = new AuthService({ password, secureCookies: false });
  const version = options.version ?? readVersion();
  const bus = options.bus ?? new EventBus();
  const attachWs = options.attachWebSockets ?? true;
  interruptActiveAgentAuthentications(machineDir);
  const terminalAuth = new TerminalAuthManager({ machineDir, bus });

  const trustedProxy = options.trustedProxy ?? options.config?.daemon?.trustedProxy ?? false;
  const trustedOrigins =
    options.trustedOrigins ??
    options.config?.daemon?.trustedOrigins ??
    (options.webUrl ? [new URL(options.webUrl).origin] : undefined);
  const app = buildApp(version, {
    root,
    repositoryId: options.repositoryId,
    bus,
    webDir: options.webDir,
    webUrl: options.webUrl,
    auth,
    trustedProxy,
    machineDir,
    terminalAuth,
  });
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
    const wsRepositoryId = options.repositoryId ?? (root ? resolveConfiguredRepositoryId(root, undefined, machineDir) : undefined);
    wsHandle = attachWebSocket(
      server as HttpServer,
      bus,
      (requestedRepositoryId) => ({
        tasks: (root ?? repositoryRoot(machineDir))
          ? listTasks(requestedRepositoryId ?? undefined, machineDir).map(taskCard)
          : [],
        threads: requestedRepositoryId
          ? listChatThreads(requestedRepositoryId, false, machineDir)
          : [],
      }),
      {
        path: "/ws",
        repositoryId: wsRepositoryId,
        authenticate: (req) => auth.isAuthenticated(req.headers.cookie),
        allowedOrigins: trustedOrigins,
        terminal: {
          pathPrefix: "/ws/terminal",
          attach: (operationId, socket) => terminalAuth.attach(operationId, socket),
        },
      },
    );
  }

  const portFile = portFilePath(machineDir);
  const layout = ensureStorageLayout(machineDir);
  const pidFile = layout.daemonPidPath;
  writeFileSync(portFile, String(bound.port), { mode: STORAGE_FILE_MODE });
  writeFileSync(pidFile, String(process.pid), { mode: STORAGE_FILE_MODE });
  chmodSync(portFile, STORAGE_FILE_MODE);
  chmodSync(pidFile, STORAGE_FILE_MODE);

  logger.info({ host: bound.host, port: bound.port, portFile }, "HTTP server listening");

  return {
    host: bound.host,
    port: bound.port,
    portFile,
    bus,
    close() {
      return closeServer(
        server,
        portFile,
        wsHandle,
        pidFile,
        terminalAuth,
      );
    },
  };
}

async function closeServer(
  server: ServerType,
  portFile: string,
  wsHandle?: WebSocketBridgeHandle,
  pidFile?: string,
  terminalAuth?: TerminalAuthManager,
): Promise<void> {
  if (terminalAuth) await terminalAuth.close();
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
  if (pidFile) {
    try {
      if (existsSync(pidFile)) unlinkSync(pidFile);
    } catch (err) {
      logger.warn({ err, pidFile }, "Failed to remove daemon pid file");
    }
  }
}
