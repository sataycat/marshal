import { describe, it, expect } from "vitest";
import { friendlyErrorMessage, extractErrorMessage } from "./errors";

describe("extractErrorMessage", () => {
  it("pulls message from an Error-like object", () => {
    expect(extractErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("pulls message from a plain object with a message", () => {
    expect(extractErrorMessage({ message: "oops" })).toBe("oops");
  });

  it("returns the string itself", () => {
    expect(extractErrorMessage("plain string")).toBe("plain string");
  });

  it("falls back to 'Unknown error' for empty/other values", () => {
    expect(extractErrorMessage(null)).toBe("Unknown error");
    expect(extractErrorMessage(undefined)).toBe("Unknown error");
    expect(extractErrorMessage({})).toBe("Unknown error");
    expect(extractErrorMessage({ message: "" })).toBe("Unknown error");
  });
});

describe("friendlyErrorMessage", () => {
  it("maps invalid_transition to a human-friendly sentence", () => {
    const err = Object.assign(new Error("Invalid transition: done -> backlog"), {
      code: "invalid_transition",
    });
    expect(friendlyErrorMessage(err)).toBe(
      "That transition is not allowed from the current state.",
    );
  });

  it("maps freeze_failed to a spec-empty hint", () => {
    const err = Object.assign(new Error("spec is empty"), { code: "freeze_failed" });
    expect(friendlyErrorMessage(err)).toBe(
      "Could not freeze the spec. Make sure the spec is not empty.",
    );
  });

  it("maps duplicate_slug", () => {
    const err = Object.assign(new Error("dup"), { code: "duplicate_slug" });
    expect(friendlyErrorMessage(err)).toBe("A task with that title already exists.");
  });

  it("maps task_not_found", () => {
    const err = Object.assign(new Error("missing"), { code: "task_not_found" });
    expect(friendlyErrorMessage(err)).toBe("That task no longer exists.");
  });

  it("falls back to the raw message for unknown codes", () => {
    const err = Object.assign(new Error("server exploded"), { code: "internal_error" });
    expect(friendlyErrorMessage(err)).toBe("server exploded");
  });

  it("falls back to the raw message when there is no code", () => {
    expect(friendlyErrorMessage(new Error("network down"))).toBe("network down");
  });
});
