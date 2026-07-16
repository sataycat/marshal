import { describe, expect, it } from "vitest";
import { nextDraftAfterSend, shouldSendDraftKey } from "./draft";

describe("draft helpers", () => {
  it("uses Cmd/Ctrl+Enter for editor sends while preserving Shift+Enter", () => {
    expect(shouldSendDraftKey({ key: "Enter", shiftKey: false, metaKey: true, ctrlKey: false })).toBe(true);
    expect(shouldSendDraftKey({ key: "Enter", shiftKey: false, metaKey: false, ctrlKey: true })).toBe(true);
    expect(shouldSendDraftKey({ key: "Enter", shiftKey: true, metaKey: true, ctrlKey: false })).toBe(false);
    expect(shouldSendDraftKey({ key: "a", shiftKey: false, metaKey: true, ctrlKey: false })).toBe(false);
  });

  it("returns the configured post-send scratch behavior", () => {
    expect(nextDraftAfterSend(false)).toBe("");
    expect(nextDraftAfterSend(true)).toBe("__retain__");
  });
});
