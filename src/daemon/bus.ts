import { logger } from "../logger.js";
import type { SpecMessage } from "../tasks/spec-store.js";
import type { ChatMessage, ChatThread } from "../chat/store.js";

export interface BusEvent<P = unknown> {
  type: string;
  payload: P;
  timestamp: string;
}

export type BusSubscriber = (event: BusEvent) => void;

export class EventBus {
  private subscribers = new Set<BusSubscriber>();

  subscribe(fn: BusSubscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  publish(type: string, payload: unknown): void {
    const event: BusEvent = { type, payload, timestamp: new Date().toISOString() };
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch (err) {
        logger.warn({ err, eventType: type }, "Event bus subscriber threw");
      }
    }
  }
}

export const TaskCreatedType = "task.created";
export const TaskUpdatedType = "task.updated";
export const TaskTransitionedType = "task.transitioned";
export const RunStartedType = "run.started";
export const RunEventType = "run.event";
export const RunFinishedType = "run.finished";
export const DaemonIdleType = "daemon.idle";
export const DaemonCycleCompleteType = "daemon.cycle_complete";
export const ConnectedType = "connected";
export const SpecMessageType = "spec.message";
export const ThreadCreatedType = "thread.created";
export const ThreadUpdatedType = "thread.updated";
export const ThreadMessageType = "thread.message";
export const ThreadDeletedType = "thread.deleted";
export const ThreadEventType = "thread.event";

export interface SpecMessagePayload {
  taskSlug: string;
  message: SpecMessage;
}

export interface TaskPayload {
  id: number;
  slug: string;
  title: string;
  status: string;
  retry_count: number;
  created_at: string;
  updated_at: string;
}

export interface TaskTransitionedPayload extends TaskPayload {
  from: string;
  to: string;
}

export interface RunPayload {
  id: number;
  taskId: number;
  role: string;
  agentId: string;
  status: string;
  prompt: string | null;
  commitSha: string | null;
  startedAt: string;
  endedAt: string | null;
  error: string | null;
}

export interface RunEventPayload {
  runId: number;
  event: unknown;
}

export interface ConnectedPayload {
  tasks: TaskPayload[];
  threads: ChatThread[];
}

export interface ThreadPayload {
  thread: ChatThread;
}

export interface ThreadMessagePayload {
  threadId: string;
  message: ChatMessage;
}

export function publishTaskCreated(bus: EventBus, task: TaskPayload): void {
  bus.publish(TaskCreatedType, { ...task });
}

export function publishTaskUpdated(bus: EventBus, task: TaskPayload): void {
  bus.publish(TaskUpdatedType, { ...task });
}

export function publishTaskTransitioned(
  bus: EventBus,
  task: TaskPayload,
  from: string,
  to: string,
): void {
  bus.publish(TaskTransitionedType, { ...task, from, to });
}

export function publishRunStarted(bus: EventBus, run: RunPayload): void {
  bus.publish(RunStartedType, { ...run });
}

export function publishRunEvent(bus: EventBus, runId: number, event: unknown): void {
  bus.publish(RunEventType, { runId, event });
}

export function publishRunFinished(bus: EventBus, run: RunPayload): void {
  bus.publish(RunFinishedType, { ...run });
}

export function publishDaemonIdle(bus: EventBus): void {
  bus.publish(DaemonIdleType, {});
}

export function publishDaemonCycleComplete(bus: EventBus): void {
  bus.publish(DaemonCycleCompleteType, {});
}

export function publishSpecMessage(bus: EventBus, taskSlug: string, message: SpecMessage): void {
  const payload: SpecMessagePayload = { taskSlug, message };
  bus.publish(SpecMessageType, payload);
}

export function publishThreadCreated(bus: EventBus, thread: ChatThread): void {
  bus.publish(ThreadCreatedType, { thread });
}

export function publishThreadUpdated(bus: EventBus, thread: ChatThread): void {
  bus.publish(ThreadUpdatedType, { thread });
}

export function publishThreadMessage(bus: EventBus, threadId: string, message: ChatMessage): void {
  bus.publish(ThreadMessageType, { threadId, message });
}

export function publishThreadDeleted(bus: EventBus, id: string): void {
  bus.publish(ThreadDeletedType, { id });
}
