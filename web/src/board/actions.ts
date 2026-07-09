import type { TaskStatus } from "../types";

export type ActionKind = "freeze" | "transition";

export interface BoardAction {
  /** Stable identifier for React keys and analytics. */
  key: string;
  /** Button label shown to the user. */
  label: string;
  /** Target status. For `freeze` this is `ready`. */
  to: TaskStatus;
  kind: ActionKind;
  /** Whether the user must confirm before the action runs (escape hatches). */
  confirm: boolean;
}

const FREEZE: BoardAction = {
  key: "freeze",
  label: "Freeze to Ready",
  to: "ready",
  kind: "freeze",
  confirm: false,
};

const MARK_DONE: BoardAction = {
  key: "mark-done",
  label: "Mark Done",
  to: "done",
  kind: "transition",
  confirm: false,
};

const REQUEUE_BUILD: BoardAction = {
  key: "requeue-build",
  label: "Re-queue Build",
  to: "ready",
  kind: "transition",
  confirm: true,
};

const BUILD_TO_BACKLOG: BoardAction = {
  key: "build-to-backlog",
  label: "Send Back to Backlog",
  to: "backlog",
  kind: "transition",
  confirm: true,
};

const VALIDATE_TO_BACKLOG: BoardAction = {
  key: "validate-to-backlog",
  label: "Send Back to Backlog",
  to: "backlog",
  kind: "transition",
  confirm: true,
};

const ACTIONS_BY_STATUS: Record<TaskStatus, BoardAction[]> = {
  backlog: [FREEZE],
  ready: [],
  building: [REQUEUE_BUILD, BUILD_TO_BACKLOG],
  validating: [VALIDATE_TO_BACKLOG],
  review: [MARK_DONE],
  done: [],
};

export function actionsForStatus(status: TaskStatus): BoardAction[] {
  return ACTIONS_BY_STATUS[status];
}

export function confirmMessage(action: BoardAction): string {
  if (!action.confirm) return "";
  if (action.to === "ready") {
    return "Re-queue this build? The retry counter will be reset.";
  }
  if (action.to === "backlog") {
    return "Send back to Backlog? The retry counter will be reset and the spec will likely need revision.";
  }
  return "Are you sure?";
}

export function isEscapeHatchAction(action: BoardAction): boolean {
  return action.confirm;
}
