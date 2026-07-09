import { describe, it, expect } from "vitest";
import { timeInState } from "./time";

describe("timeInState", () => {
  const now = new Date("2026-01-02T00:00:00.000Z").getTime();

  it("formats seconds", () => {
    expect(timeInState(new Date(now - 5_000).toISOString(), now)).toBe("5s");
  });

  it("formats minutes", () => {
    expect(timeInState(new Date(now - 125_000).toISOString(), now)).toBe("2m");
  });

  it("formats hours", () => {
    expect(timeInState(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe("3h");
  });

  it("formats days", () => {
    expect(timeInState(new Date(now - 2 * 86_400_000).toISOString(), now)).toBe("2d");
  });

  it("clamps clock skew / future timestamps to 0s", () => {
    expect(timeInState(new Date(now + 5_000).toISOString(), now)).toBe("0s");
  });
});
