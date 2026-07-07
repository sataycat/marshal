export type TaskStatus = "backlog" | "ready" | "building" | "validating" | "review" | "done";

export const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  backlog: ["ready"],
  ready: ["building"],
  building: ["validating"],
  validating: ["building", "review"],
  review: ["done"],
  done: [],
};

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
