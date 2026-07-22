import { describe, expect, it } from "vitest";
import { authenticationRecovery } from "./authRecovery";
import type { ChatMessage, ChatThread } from "../types";

const failure = { kind: "authentication_required" as const, message: "Sign in", protocol_code: -32000, data: null };
const thread = { id: "t", status: "authentication_required", failure } as ChatThread;
const message = { id: 1, thread_id: "t", role: "user", content: "exact", created_at: "now", attachment_ids: [], prompt_status: "authentication_required", failure } as ChatMessage;

describe("authenticationRecovery", () => {
  it("selects the preserved prompt only from structured authentication-required state", () => { expect(authenticationRecovery(thread, [message])).toEqual({ required: true, message }); });
  it("does not classify auth-like ordinary failures", () => { expect(authenticationRecovery({ ...thread, status: "error", failure: { ...failure, kind: "agent_internal_error", message: "run /login" } }, [{ ...message, prompt_status: null }])).toEqual({ required: false, message: null }); });
});
