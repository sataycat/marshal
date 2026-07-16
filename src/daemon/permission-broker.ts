import type { AgentPermissionRequest, PermissionOption } from "../agent/types.js";
import { ThreadEventType, type EventBus } from "./bus.js";

export interface PendingPermission extends AgentPermissionRequest {
  threadId: string;
}

interface PendingEntry {
  request: PendingPermission;
  resolve: (optionId: string | undefined) => void;
}

export class PermissionDecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionDecisionError";
  }
}

export class PermissionBroker {
  private readonly pending = new Map<string, PendingEntry>();

  constructor(private readonly bus?: EventBus) {}

  request(threadId: string, request: AgentPermissionRequest): Promise<string | undefined> {
    const pending: PendingPermission = { ...request, threadId, options: request.options.map(copyOption) };
    return new Promise<string | undefined>((resolve) => {
      this.pending.set(request.requestId, { request: pending, resolve });
      this.bus?.publish(ThreadEventType, { threadId, event: { type: "permission-request", request: pending } });
    });
  }

  list(threadId: string): PendingPermission[] {
    return [...this.pending.values()].map((entry) => entry.request).filter((request) => request.threadId === threadId).map((request) => ({ ...request, options: request.options.map(copyOption) }));
  }

  decide(threadId: string, requestId: string, action: "approve" | "deny"): PendingPermission {
    const entry = this.pending.get(requestId);
    if (!entry || entry.request.threadId !== threadId) throw new PermissionDecisionError("Permission request is stale or unknown");
    const kind = action === "approve" ? "allow_once" : "reject_once";
    const option = entry.request.options.find((candidate) => candidate.kind === kind);
    if (!option) throw new PermissionDecisionError(`Permission request does not offer ${kind}`);
    this.pending.delete(requestId);
    entry.resolve(option.optionId);
    this.bus?.publish(ThreadEventType, { threadId, event: { type: "permission-resolved", requestId, action, granted: action === "approve" } });
    return entry.request;
  }

  cancelThread(threadId: string): void {
    for (const [requestId, entry] of this.pending) {
      if (entry.request.threadId !== threadId) continue;
      this.pending.delete(requestId);
      entry.resolve(undefined);
      this.bus?.publish(ThreadEventType, { threadId, event: { type: "permission-resolved", requestId, action: "cancelled", granted: false } });
    }
  }

  clear(): void {
    for (const entry of this.pending.values()) entry.resolve(undefined);
    this.pending.clear();
  }
}

function copyOption(option: PermissionOption): PermissionOption {
  return { optionId: option.optionId, name: option.name, kind: option.kind };
}
