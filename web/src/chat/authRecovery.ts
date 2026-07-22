import type { ChatMessage, ChatThread } from "../types";

export function authenticationRecovery(thread: ChatThread, messages: ChatMessage[]): { required: boolean; message: ChatMessage | null } {
  if (thread.status !== "authentication_required" || thread.failure?.kind !== "authentication_required") return { required: false, message: null };
  return { required: true, message: [...messages].reverse().find((message) => message.role === "user" && message.prompt_status === "authentication_required" && message.failure?.kind === "authentication_required") ?? null };
}
