export type TaskStatus = "backlog" | "ready" | "building" | "validating" | "review" | "done";

export const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  backlog: ["ready"],
  ready: ["building"],
  building: ["validating", "ready", "backlog"],
  validating: ["building", "review", "backlog"],
  review: ["done", "backlog"],
  done: [],
};

export const ESCAPE_HATCH_TRANSITIONS: ReadonlyArray<readonly [TaskStatus, TaskStatus]> = [
  ["building", "ready"],
  ["building", "backlog"],
  ["validating", "backlog"],
  ["review", "backlog"],
] as const;

export function isEscapeHatch(from: TaskStatus, to: TaskStatus): boolean {
  return ESCAPE_HATCH_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

export function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Invalid transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!isValidTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}

export function isTaskStatus(value: string): value is TaskStatus {
  return Object.keys(VALID_TRANSITIONS).includes(value);
}

export function asTaskStatus(value: string): TaskStatus {
  if (!isTaskStatus(value)) {
    throw new Error(`Unknown task status: ${value}`);
  }
  return value;
}
