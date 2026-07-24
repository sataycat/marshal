import { WebSocketServer, type WebSocket } from "ws";
import type { Server } from "node:http";
import { URL } from "node:url";
import { logger } from "../logger.js";
import {
  ConnectedType,
  type BusEvent,
  type BusSubscriber,
  type ConnectedPayload,
  type EventBus,
  type TaskPayload,
} from "./bus.js";
import type { ChatThread } from "../chat/store.js";

export interface WebSocketBridgeOptions {
  path: string;
  repositoryId?: string;
  pingIntervalMs?: number;
  dropAfterMs?: number;
  authenticate?: (req: import("node:http").IncomingMessage) => boolean;
  allowedOrigins?: string[];
  terminal?: {
    pathPrefix: string;
    attach(operationId: string, socket: WebSocket): boolean;
  };
}

export interface WebSocketBridgeHandle {
  close(): Promise<void>;
  clientCount(): number;
}

const DEFAULT_PING_INTERVAL_MS = 30_000;
const DEFAULT_DROP_AFTER_MS = 90_000;

interface ClientState {
  repositoryId?: string;
  lastPongAt: number;
  pingTimer: NodeJS.Timeout;
}

export function attachWebSocket(
  server: Server,
  bus: EventBus,
  snapshot: (repositoryId?: string) => TaskPayload[] | { tasks: TaskPayload[]; threads: ChatThread[] },
  options: WebSocketBridgeOptions,
): WebSocketBridgeHandle {
  const path = options.path;
  const pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const dropAfterMs = options.dropAfterMs ?? DEFAULT_DROP_AFTER_MS;

  const wss = new WebSocketServer({ noServer: true });
  const terminalWss = new WebSocketServer({ noServer: true });
  const clients = new Map<WebSocket, ClientState>();

  function onUpgrade(req: import("node:http").IncomingMessage, socket: import("node:net").Socket, head: Buffer): void {
    const requestUrl = new URL(req.url ?? "", "http://127.0.0.1");
    const terminalPrefix = options.terminal?.pathPrefix;
    const terminalOperationId = terminalPrefix && requestUrl.pathname.startsWith(`${terminalPrefix}/`) ? decodeURIComponent(requestUrl.pathname.slice(terminalPrefix.length + 1)) : null;
    const requestedRepositoryId = requestUrl.searchParams.get("repository_id");
    if (options.repositoryId && requestedRepositoryId && requestedRepositoryId !== options.repositoryId) {
      socket.destroy();
      return;
    }
    if (requestUrl.pathname !== path && !terminalOperationId) {
      socket.destroy();
      return;
    }
    const origin = req.headers.origin;
    if (origin) {
      let ownOrigin = false;
      try {
        ownOrigin = new URL(origin).host === req.headers.host;
      } catch {
        ownOrigin = false;
      }
      if (!ownOrigin && !options.allowedOrigins?.includes(origin)) {
        socket.destroy();
        return;
      }
    }
    if (options.authenticate && !options.authenticate(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const target = terminalOperationId ? terminalWss : wss;
    target.handleUpgrade(req, socket, head, (ws) => {
      if (terminalOperationId && !options.terminal?.attach(terminalOperationId, ws)) {
        ws.close(1008, "Unknown, non-terminal, or completed operation");
        return;
      }
      target.emit("connection", ws, req);
    });
  }

  server.on("upgrade", onUpgrade);

  const subscriber: BusSubscriber = (event: BusEvent) => {
    broadcast(event);
  };
  const unsubscribe = bus.subscribe(subscriber);

  wss.on("connection", (ws, req) => {
    const requestUrl = new URL(req.url ?? "", "http://127.0.0.1");
    const requestedRepositoryId = requestUrl.searchParams.get("repository_id") ?? undefined;
    const pingTimer = setInterval(() => sendPing(ws), pingIntervalMs);
    clients.set(ws, {
      repositoryId: requestedRepositoryId ?? options.repositoryId,
      lastPongAt: Date.now(),
      pingTimer,
    });

    ws.on("pong", () => {
      const state = clients.get(ws);
      if (state) state.lastPongAt = Date.now();
    });

    ws.on("close", () => removeClient(ws));
    ws.on("error", (err) => {
      logger.warn({ err }, "WebSocket client error");
      removeClient(ws);
    });

    const state = clients.get(ws);
    const currentSnapshot = snapshot(state?.repositoryId);
    const connectedPayload: ConnectedPayload = Array.isArray(currentSnapshot)
      ? { tasks: currentSnapshot, threads: [] }
      : currentSnapshot;
    const connectedEvent: BusEvent = {
      type: ConnectedType,
      payload: { ...connectedPayload, repository_id: state?.repositoryId ?? null },
      timestamp: new Date().toISOString(),
    };
    safeSend(ws, JSON.stringify(connectedEvent));
  });

  function sendPing(ws: WebSocket): void {
    const state = clients.get(ws);
    if (!state) return;
    if (Date.now() - state.lastPongAt > dropAfterMs) {
      logger.warn({ path }, "WebSocket client silent, dropping");
      terminate(ws);
      return;
    }
    try {
      ws.ping();
    } catch {
      removeClient(ws);
    }
  }

  function removeClient(ws: WebSocket): void {
    const state = clients.get(ws);
    if (!state) return;
    clearInterval(state.pingTimer);
    clients.delete(ws);
    try {
      if (ws.readyState !== ws.CLOSED && ws.readyState !== ws.CLOSING) ws.close();
    } catch {
      // ignore
    }
  }

  function terminate(ws: WebSocket): void {
    removeClient(ws);
    try {
      ws.terminate();
    } catch {
      // ignore
    }
  }

  function broadcast(event: BusEvent): void {
    const eventRepositoryId = eventRepositoryIdOf(event);
    if (eventRepositoryId && options.repositoryId && eventRepositoryId !== options.repositoryId) return;
    const data = JSON.stringify(event);
    for (const [ws, state] of clients) {
      if (eventRepositoryId && state.repositoryId && eventRepositoryId !== state.repositoryId) continue;
      // Repository-scoped events must never reach an unscoped browser. This
      // also makes a missing repository selection fail closed during startup.
      if (eventRepositoryId && !state.repositoryId) continue;
      safeSend(ws, data);
    }
  }

  function eventRepositoryIdOf(event: BusEvent): string | null {
    const payload = event.payload;
    if (!payload || typeof payload !== "object") return null;
    const value = (payload as { repositoryId?: unknown; repository_id?: unknown }).repositoryId ??
      (payload as { repository_id?: unknown }).repository_id;
    return typeof value === "string" ? value : null;
  }

  function safeSend(ws: WebSocket, data: string): void {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(data);
    } catch (err) {
      logger.warn({ err }, "WebSocket send failed, dropping client");
      removeClient(ws);
    }
  }

  return {
    clientCount() {
      return clients.size;
    },
    close() {
      return new Promise<void>((resolve) => {
        server.off("upgrade", onUpgrade);
        unsubscribe();
        for (const state of clients.values()) {
          clearInterval(state.pingTimer);
        }
        for (const ws of clients.keys()) {
          try {
            ws.terminate();
          } catch {
            // ignore
          }
        }
        clients.clear();
        wss.close(() => resolve());
        terminalWss.close();
      });
    },
  };
}
