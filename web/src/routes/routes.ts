import { type ComponentType, type LazyExoticComponent } from "react";

export const ROUTES = {
  home: "/",
  chat: "/chat",
  chatThread: (threadId: string): `/chat/${string}` => `/chat/${threadId}`,
} as const;

export type StaticPath = (typeof ROUTES)["home" | "chat"];
export type ChatPath = `/chat/${string}`;
export type RoutePath = StaticPath | ChatPath;

export const NAV_ITEMS: readonly { path: StaticPath; label: string }[] = [
  { path: ROUTES.chat, label: "Chat" },
];

export interface RouteComponent {
  Chat: ComponentType;
  ChatThread: ComponentType<{ threadId: string }>;
}

export interface RouteLoaders {
  Chat: () => Promise<{ default: ComponentType }>;
  ChatThread: () => Promise<{ default: ComponentType<{ threadId: string }> }>;
}

export interface LazyRouteComponents {
  Chat: LazyExoticComponent<ComponentType>;
  ChatThread: LazyExoticComponent<ComponentType<{ threadId: string }>>;
}

export const ROUTE_LOADERS: RouteLoaders = {
  Chat: () => import("./ChatRoute").then((m) => ({ default: m.ChatRoute })),
  ChatThread: () => import("./ChatThreadRoute").then((m) => ({ default: m.ChatThreadRoute })),
};

export function matchChatPath(path: string): string | null {
  const m = /^\/chat\/([^/]+)$/.exec(path);
  return m && m[1] ? m[1] : null;
}

export function preloadStatic(path: StaticPath): void {
  switch (path) {
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
