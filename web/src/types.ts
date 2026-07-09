export type TaskStatus = "backlog" | "ready" | "building" | "validating" | "review" | "done";

export interface TaskCard {
  id: number;
  slug: string;
  title: string;
  status: TaskStatus;
  retry_count: number;
  created_at: string;
  updated_at: string;
}

export interface TaskDetail extends TaskCard {
  spec_markdown: string;
  last_failure: string | null;
}

export interface BusEvent<P = unknown> {
  type: string;
  payload: P;
  timestamp: string;
}

export interface ConnectedPayload {
  tasks: TaskCard[];
}
