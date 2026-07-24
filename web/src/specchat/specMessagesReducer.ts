import type { BusEvent, SpecMessage } from "../types";

export type SpecMessagesState = Record<string, SpecMessage[]>;

export function specMessagesReducer(state: SpecMessagesState, event: BusEvent): SpecMessagesState {
  if (event.type === "spec.message") {
    const payload = event.payload as { taskSlug: string; message: SpecMessage };
    const { taskSlug, message } = payload;
    const repositoryId = (payload as { repositoryId?: string }).repositoryId ?? message.repository_id ?? "";
    const key = `${repositoryId}:${taskSlug}`;
    const existing = state[key] ?? [];
    if (existing.some((m) => m.id === message.id)) return state;
    return { ...state, [key]: [...existing, message] };
  }
  if (event.type === "connected") {
    // A fresh connection resets the in-memory chat cache; HTTP is the durable
    // source and the panel re-fetches on mount anyway.
    return {};
  }
  return state;
}

export function messagesForSlug(state: SpecMessagesState, slug: string): SpecMessage[] {
  return state[slug] ?? [];
}
