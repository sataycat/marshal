import { describe, it, expect, beforeEach } from "vitest";
import {
  toastReducer,
  addErrorToast,
  addInfoToast,
  addSuccessToast,
  resetToastIdCounter,
  type ToastState,
} from "./toast";

describe("toastReducer", () => {
  beforeEach(() => {
    resetToastIdCounter();
  });

  it("adds an error toast with an incrementing id", () => {
    const state: ToastState = [];
    const next = toastReducer(state, addErrorToast("boom"));
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ kind: "error", message: "boom" });
    expect(next[0].id).toBe(1);

    const next2 = toastReducer(next, addInfoToast("hi"));
    expect(next2[1].id).toBe(2);
    expect(next2[1].kind).toBe("info");
  });

  it("adds info and success toasts via helpers", () => {
    const s1 = toastReducer([], addInfoToast("info"));
    const s2 = toastReducer(s1, addSuccessToast("done"));
    expect(s2).toHaveLength(2);
    expect(s2.map((t) => t.kind)).toEqual(["info", "success"]);
  });

  it("dismiss removes only the matching toast", () => {
    const s1 = toastReducer([], addErrorToast("a"));
    const s2 = toastReducer(s1, addErrorToast("b"));
    const id = s2[0].id;
    const next = toastReducer(s2, { type: "dismiss", id });
    expect(next.map((t) => t.message)).toEqual(["b"]);
  });

  it("dismiss with an unknown id leaves state unchanged (filtered, not same ref)", () => {
    const s1 = toastReducer([], addErrorToast("a"));
    const next = toastReducer(s1, { type: "dismiss", id: 9999 });
    expect(next).toHaveLength(1);
    expect(next[0].message).toBe("a");
  });

  it("does not mutate the previous state array", () => {
    const s1 = toastReducer([], addErrorToast("a"));
    toastReducer(s1, addErrorToast("b"));
    expect(s1).toHaveLength(1);
  });

  it("returns state unchanged for an unknown action type", () => {
    const state: ToastState = [{ id: 1, kind: "info", message: "x" }];
    const next = toastReducer(state, { type: "noop" } as unknown as Parameters<typeof toastReducer>[1]);
    expect(next).toBe(state);
  });
});
