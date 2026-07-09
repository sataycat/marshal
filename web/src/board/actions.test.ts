import { describe, it, expect } from "vitest";
import { actionsForStatus, confirmMessage, isEscapeHatchAction } from "./actions";

describe("actionsForStatus", () => {
  it("offers a single freeze action from backlog", () => {
    const actions = actionsForStatus("backlog");
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: "freeze", to: "ready", confirm: false });
  });

  it("offers no manual actions from ready (daemon claims it)", () => {
    expect(actionsForStatus("ready")).toEqual([]);
  });

  it("offers re-queue and send-back escape hatches from building", () => {
    const actions = actionsForStatus("building");
    expect(actions.map((a) => a.to).sort()).toEqual(["backlog", "ready"]);
    expect(actions.every((a) => a.confirm)).toBe(true);
    expect(actions.every((a) => a.kind === "transition")).toBe(true);
  });

  it("offers a single send-back escape hatch from validating", () => {
    const actions = actionsForStatus("validating");
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ to: "backlog", confirm: true, kind: "transition" });
  });

  it("offers a mark-done action from review (no confirmation)", () => {
    const actions = actionsForStatus("review");
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ to: "done", confirm: false, kind: "transition" });
  });

  it("offers no actions from done", () => {
    expect(actionsForStatus("done")).toEqual([]);
  });

  it("returns a stable array reference per status", () => {
    expect(actionsForStatus("backlog")).toBe(actionsForStatus("backlog"));
  });

  it("every action key is unique within a status", () => {
    const all = (
      ["backlog", "ready", "building", "validating", "review", "done"] as const
    ).flatMap(actionsForStatus);
    const keys = all.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("confirmMessage", () => {
  it("returns empty string for non-confirm actions", () => {
    expect(confirmMessage(actionsForStatus("backlog")[0])).toBe("");
    expect(confirmMessage(actionsForStatus("review")[0])).toBe("");
  });

  it("mentions retry reset for re-queue (building -> ready)", () => {
    const requeue = actionsForStatus("building").find((a) => a.to === "ready")!;
    expect(confirmMessage(requeue)).toMatch(/retry counter will be reset/i);
    expect(confirmMessage(requeue)).not.toMatch(/spec will/i);
  });

  it("mentions retry reset and spec revision for send-back to backlog", () => {
    const back = actionsForStatus("building").find((a) => a.to === "backlog")!;
    expect(confirmMessage(back)).toMatch(/retry counter will be reset/i);
    expect(confirmMessage(back)).toMatch(/spec will/i);
  });

  it("mentions retry reset and spec revision for validating -> backlog", () => {
    const back = actionsForStatus("validating")[0];
    expect(confirmMessage(back)).toMatch(/retry counter will be reset/i);
    expect(confirmMessage(back)).toMatch(/spec will/i);
  });
});

describe("isEscapeHatchAction", () => {
  it("treats confirm=true actions as escape hatches", () => {
    expect(isEscapeHatchAction(actionsForStatus("building")[0])).toBe(true);
  });

  it("treats confirm=false actions as non-escape-hatches", () => {
    expect(isEscapeHatchAction(actionsForStatus("backlog")[0])).toBe(false);
    expect(isEscapeHatchAction(actionsForStatus("review")[0])).toBe(false);
  });
});
