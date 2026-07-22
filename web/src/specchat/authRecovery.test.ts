import { describe, expect, it } from "vitest";
import { recoverableSpecMessage } from "./authRecovery";
import type { SpecMessage } from "../types";
const base = { id: 1, task_id: 1, role: "user", content: "exact", created_at: "now" } as SpecMessage;
describe("recoverableSpecMessage", () => {
  it("requires structured AuthRequired", () => { const message = { ...base, prompt_status: "authentication_required" as const, failure: { kind: "authentication_required" as const, message: "sign in", protocol_code: -32000, data: null } }; expect(recoverableSpecMessage([message])).toBe(message); });
  it("ignores auth-like ordinary prose", () => { expect(recoverableSpecMessage([{ ...base, failure: { kind: "agent_internal_error", message: "run /login", protocol_code: null, data: null } }])).toBeNull(); });
});
