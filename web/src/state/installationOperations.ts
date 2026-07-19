import type { BusEvent, InstallationOperation } from "../types";

export interface InstallationOperationsState {
  byId: Record<string, InstallationOperation>;
}

export function isTerminalInstallationOperation(operation: Pick<InstallationOperation, "status" | "phase">): boolean {
  return operation.phase === "completed" || operation.phase === "failed" || operation.phase === "interrupted" || operation.status !== "installing";
}

export function applyInstallationOperationEvent(
  state: InstallationOperationsState,
  event: BusEvent,
): InstallationOperationsState {
  if (event.type !== "installation.operation.updated") return state;
  const operation = (event.payload as { operation?: InstallationOperation }).operation;
  if (!operation) return state;
  return { byId: { ...state.byId, [operation.id]: operation } };
}

export function retryInstallationOperation(
  state: InstallationOperationsState,
  operation: InstallationOperation,
): InstallationOperationsState {
  const next = { ...operation, status: "installing" as const, phase: "resolving" as const, finished_at: null, error: null, error_code: null, diagnostic: null };
  return { byId: { ...state.byId, [next.id]: next } };
}
