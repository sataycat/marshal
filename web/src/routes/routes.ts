import { type ComponentType, type LazyExoticComponent } from "react";

export const ROUTES = {
  home: "/",
  board: "/board",
  chat: "/chat",
  chatThread: (threadId: string): `/chat/${string}` => `/chat/${threadId}`,
} as const;

export type StaticPath = (typeof ROUTES)["home" | "board" | "chat"];
export type ChatPath = `/chat/${string}`;
export type RoutePath = StaticPath | ChatPath;

export const NAV_ITEMS: readonly { path: StaticPath; label: string }[] = [
  { path: ROUTES.board, label: "Board" },
  { path: ROUTES.chat, label: "Chat" },
];

export interface RouteComponent {
  Board: ComponentType;
  Chat: ComponentType;
  ChatThread: ComponentType<{ threadId: string }>;
}

export interface RouteLoaders {
  Board: () => Promise<{ default: ComponentType }>;
  Chat: () => Promise<{ default: ComponentType }>;
  ChatThread: () => Promise<{ default: ComponentType<{ threadId: string }> }>;
}

export interface LazyRouteComponents {
  Board: LazyExoticComponent<ComponentType>;
  Chat: LazyExoticComponent<ComponentType>;
  ChatThread: LazyExoticComponent<ComponentType<{ threadId: string }>>;
}

export const ROUTE_LOADERS: RouteLoaders = {
  Board: () => import("./BoardRoute").then((m) => ({ default: m.BoardRoute })),
  Chat: () => import("./ChatRoute").then((m) => ({ default: m.ChatRoute })),
  ChatThread: () => import("./ChatThreadRoute").then((m) => ({ default: m.ChatThreadRoute })),
};

export function matchChatPath(path: string): string | null {
  const m = /^\/chat\/([^/]+)$/.exec(path);
  return m && m[1] ? m[1] : null;
}

export function preloadStatic(path: StaticPath): void {
  switch (path) {
    case ROUTES.board:
      void ROUTE_LOADERS.Board();
      return;
    case ROUTES.chat:
      void ROUTE_LOADERS.Chat();
      return;
    case ROUTES.home:
      return;
  }
}

export function preloadThread(): void {
  void ROUTE_LOADERS.ChatThread();
}
