import { Hono } from "hono";
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

export function buildApp(version: string): Hono {
  const app = new Hono();
  app.get("/api/health", (c) => c.json({ status: "ok", version }));
  return app;
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

  const app = buildApp(version);
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