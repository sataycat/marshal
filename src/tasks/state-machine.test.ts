import { describe, expect, it } from "vitest";
import {
  asTaskStatus,
  assertTransition,
  isTaskStatus,
  isValidTransition,
  InvalidTransitionError,
  VALID_TRANSITIONS,
} from "./state-machine.js";

describe("state-machine", () => {
  it("allows the six M0 transitions", () => {
    expect(isValidTransition("backlog", "ready")).toBe(true);
    expect(isValidTransition("ready", "building")).toBe(true);
    expect(isValidTransition("building", "validating")).toBe(true);
    expect(isValidTransition("validating", "building")).toBe(true);
    expect(isValidTransition("validating", "review")).toBe(true);
    expect(isValidTransition("review", "done")).toBe(true);
  });

  it("rejects invalid transitions", () => {
    expect(isValidTransition("backlog", "done")).toBe(false);
    expect(isValidTransition("ready", "review")).toBe(false);
    expect(isValidTransition("done", "backlog")).toBe(false);
    expect(isValidTransition("building", "review")).toBe(false);
  });

  it("has no outgoing transitions from done", () => {
    expect(VALID_TRANSITIONS.done).toEqual([]);
  });

  it("allows validating -> building (retry)", () => {
    expect(isValidTransition("validating", "building")).toBe(true);
  });

  it("throws on invalid assertTransition", () => {
    expect(() => assertTransition("backlog", "done")).toThrow(InvalidTransitionError);
  });

  it("does not throw on valid assertTransition", () => {
    expect(() => assertTransition("backlog", "ready")).not.toThrow();
  });

  it("recognizes valid status strings", () => {
    expect(isTaskStatus("backlog")).toBe(true);
    expect(isTaskStatus("done")).toBe(true);
    expect(isTaskStatus("frobnicated")).toBe(false);
    expect(isTaskStatus("")).toBe(false);
  });

  it("narrows via asTaskStatus", () => {
    expect(asTaskStatus("ready")).toBe("ready");
    expect(() => asTaskStatus("nope")).toThrow("Unknown task status");
  });
});
