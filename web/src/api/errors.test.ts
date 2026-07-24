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

  it("maps merge_conflict to a resolve-and-retry message", () => {
    const err = Object.assign(new Error("conflict"), { code: "merge_conflict" });
    expect(friendlyErrorMessage(err)).toMatch(/conflict/i);
  });

  it("maps merge_failed to a dirty-checkout hint", () => {
    const err = Object.assign(new Error("boom"), { code: "merge_failed" });
    expect(friendlyErrorMessage(err)).toMatch(/dirty/i);
  });

  it("maps no_worktree to a worktree hint", () => {
    const err = Object.assign(new Error("nope"), { code: "no_worktree" });
    expect(friendlyErrorMessage(err)).toMatch(/worktree/);
  });

  it("maps not_review to a review-only hint", () => {
    const err = Object.assign(new Error("nope"), { code: "not_review" });
    expect(friendlyErrorMessage(err)).toMatch(/review/i);
  });

  it("maps diff_failed to a load-failure message", () => {
    const err = Object.assign(new Error("nope"), { code: "diff_failed" });
    expect(friendlyErrorMessage(err)).toMatch(/diff/);
  });

  it("falls back to the raw message for unknown codes", () => {
    const err = Object.assign(new Error("server exploded"), { code: "internal_error" });
    expect(friendlyErrorMessage(err)).toBe("server exploded");
  });

  it("falls back to the raw message when there is no code", () => {
    expect(friendlyErrorMessage(new Error("network down"))).toBe("network down");
  });

  it("keeps removal conflicts and cleanup failures actionable", () => {
    expect(friendlyErrorMessage(Object.assign(new Error("live references"), { code: "agent_removal_conflict" }))).toMatch(/resolve|removal/i);
    expect(friendlyErrorMessage(Object.assign(new Error("payload locked"), { code: "agent_cleanup_failed" }))).toMatch(/retry|cleanup/i);
  });

  it("keeps attachment failures actionable", () => {
    expect(friendlyErrorMessage(Object.assign(new Error("quota"), { code: "attachment_quota" }))).toMatch(/40 MiB/);
    expect(friendlyErrorMessage(Object.assign(new Error("too many"), { code: "attachment_limit" }))).toMatch(/8 unique/);
    expect(friendlyErrorMessage(Object.assign(new Error("bad image"), { code: "invalid_image" }))).toMatch(/supported image/);
    expect(friendlyErrorMessage(Object.assign(new Error("gone"), { code: "attachment_missing" }))).toMatch(/upload it again/);
  });
});
