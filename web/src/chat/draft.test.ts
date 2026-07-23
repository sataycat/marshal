import { describe, expect, it } from "vitest";
import { nextDraftAfterSend, shouldInitializeDraftSession, shouldSendDraftKey } from "./draft";

describe("draft helpers", () => {
  it("uses Cmd/Ctrl+Enter for editor sends while preserving Shift+Enter", () => {
    expect(
      shouldSendDraftKey({ key: "Enter", shiftKey: false, metaKey: true, ctrlKey: false }),
    ).toBe(true);
    expect(
      shouldSendDraftKey({ key: "Enter", shiftKey: false, metaKey: false, ctrlKey: true }),
    ).toBe(true);
    expect(
      shouldSendDraftKey({ key: "Enter", shiftKey: true, metaKey: true, ctrlKey: false }),
    ).toBe(false);
    expect(shouldSendDraftKey({ key: "a", shiftKey: false, metaKey: true, ctrlKey: false })).toBe(
      false,
    );
  });

  it("returns the configured post-send scratch behavior", () => {
    expect(nextDraftAfterSend(false)).toBe("");
    expect(nextDraftAfterSend(true)).toBe("__retain__");
  });

  it("does not repeat draft session initialization for the same selection", () => {
    expect(shouldInitializeDraftSession("repo:agent", null, null)).toBe(true);
    expect(shouldInitializeDraftSession("repo:agent", null, "repo:agent")).toBe(false);
    expect(shouldInitializeDraftSession("repo:agent", "repo:agent", null)).toBe(false);
    expect(shouldInitializeDraftSession(null, null, null)).toBe(false);
  });
});
