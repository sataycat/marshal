import { describe, it, expect } from "vitest";
import { NAV_ITEMS, ROUTES, matchChatPath, preloadStatic, preloadThread } from "./routes";

describe("ROUTES", () => {
  it("exposes static paths as literals", () => {
    expect(ROUTES.home).toBe("/");
    expect(ROUTES.chat).toBe("/chat");
  });

  it("builds a chat thread path with the given id", () => {
    expect(ROUTES.chatThread("abc-123")).toBe("/chat/abc-123");
  });
});

describe("NAV_ITEMS", () => {
  it("has a Chat entry pointing at a static path", () => {
    const paths = NAV_ITEMS.map((i) => i.path);
    expect(paths).toEqual([ROUTES.chat]);
  });

  it("gives every entry a non-empty label", () => {
    for (const item of NAV_ITEMS) {
      expect(item.label.length).toBeGreaterThan(0);
    }
  });
});

describe("matchChatPath", () => {
  it("extracts the thread id from a /chat/:id path", () => {
    expect(matchChatPath("/chat/abc-123")).toBe("abc-123");
  });

  it("returns null for the bare /chat path", () => {
    expect(matchChatPath("/chat")).toBeNull();
    expect(matchChatPath("/chat/")).toBeNull();
  });

  it("returns null for a chat path with extra segments", () => {
    expect(matchChatPath("/chat/foo/bar")).toBeNull();
  });

  it("returns null for unrelated paths", () => {
    expect(matchChatPath("/")).toBeNull();
    expect(matchChatPath("")).toBeNull();
  });
});

describe("preload helpers", () => {
  it("preloadStatic is a no-op for the home path", () => {
    expect(() => preloadStatic(ROUTES.home)).not.toThrow();
  });

  it("preloadStatic kicks off the chat lazy import", () => {
    // We just need the call not to throw; the import is fire-and-forget.
    expect(() => preloadStatic(ROUTES.chat)).not.toThrow();
  });

  it("preloadThread kicks off the chat thread lazy import", () => {
    expect(() => preloadThread()).not.toThrow();
  });
});
