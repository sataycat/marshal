import { describe, it, expect } from "vitest";
import {
  NAV_ITEMS,
  ROUTES,
  chatPathForAgent,
  matchChatPath,
  preloadStatic,
  preloadThread,
  selectedAgentFromSearch,
} from "./routes";

describe("ROUTES", () => {
  it("exposes static paths as literals", () => {
    expect(ROUTES.home).toBe("/");
    expect(ROUTES.chat).toBe("/chat");
    expect(ROUTES.board).toBe("/board");
    expect(ROUTES.workflows).toBe("/workflows");
  });

  it("builds a chat session path with the given id", () => {
    expect(ROUTES.chatThread("abc-123")).toBe("/chat/abc-123");
  });

  it("builds a new chat path for an exact installed agent version", () => {
    expect(chatPathForAgent("claude-acp", "0.61.0")).toBe("/chat?agent=claude-acp%400.61.0");
  });
});

describe("NAV_ITEMS", () => {
  it("only exposes ready primary product areas", () => {
    const paths = NAV_ITEMS.map((i) => i.path);
    expect(paths).toEqual([ROUTES.chat, ROUTES.board, ROUTES.workflows, ROUTES.agents]);
  });

  it("gives every entry a non-empty label", () => {
    for (const item of NAV_ITEMS) {
      expect(item.label.length).toBeGreaterThan(0);
    }
  });
});

describe("matchChatPath", () => {
  it("extracts the session id from a /chat/:id path", () => {
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

describe("selectedAgentFromSearch", () => {
  it("reads the selected agent key from the chat query", () => {
    expect(selectedAgentFromSearch("?agent=claude-acp%400.61.0")).toBe("claude-acp@0.61.0");
  });

  it("returns null when the query does not select an agent", () => {
    expect(selectedAgentFromSearch("?project=%2Frepo")).toBeNull();
    expect(selectedAgentFromSearch("?agent=")).toBeNull();
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

  it("preloadThread kicks off the chat session lazy import", () => {
    expect(() => preloadThread()).not.toThrow();
  });
});
