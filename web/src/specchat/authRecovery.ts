import type { SpecMessage } from "../types";

export function recoverableSpecMessage(messages: SpecMessage[]): SpecMessage | null { return [...messages].reverse().find((message) => message.role === "user" && message.prompt_status === "authentication_required" && message.failure?.kind === "authentication_required") ?? null; }
