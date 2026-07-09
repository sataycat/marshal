export type BoardState = Record<number, TaskCard>;

import type { BusEvent, TaskCard } from "../types";

export function boardReducer(state: BoardState, event: BusEvent): BoardState {
  switch (event.type) {
    case "connected": {
      const tasks = (event.payload as { tasks: TaskCard[] }).tasks;
      const next: BoardState = {};
      for (const task of tasks) next[task.id] = task;
      return next;
    }
    case "task.created":
    case "task.updated":
    case "task.transitioned":
    case "optimistic.apply":
    case "optimistic.commit":
    case "optimistic.rollback": {
      const task = event.payload as TaskCard;
      return { ...state, [task.id]: task };
    }
    default:
      return state;
  }
}

export function boardToList(state: BoardState): TaskCard[] {
  return Object.values(state).sort((a, b) => {
    if (a.created_at === b.created_at) return b.id - a.id;
    return a.created_at < b.created_at ? 1 : -1;
  });
}
