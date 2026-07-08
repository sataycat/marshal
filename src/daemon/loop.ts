import { logger } from "../logger.js";
import { runOnce, type RunOnceOptions, type RunOnceResult } from "./orchestrator.js";

export const DEFAULT_DAEMON_INTERVAL_MS = 5000;

export interface StartDaemonOptions extends RunOnceOptions {
  intervalMs?: number;
  signal?: AbortSignal;
}

export function formatRunOnceResult(result: RunOnceResult | null): string {
  if (result === null) {
    return "no ready task";
  }
  const parts: string[] = [result.slug, result.status];
  if (result.commitSha) {
    parts.push(result.commitSha.slice(0, 12));
  }
  if (result.error) {
    parts.push(`error: ${result.error}`);
  }
  if (result.reason) {
    parts.push(`reason: ${result.reason}`);
  }
  return parts.join(" ");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort);
  });
}

export async function startDaemon(options: StartDaemonOptions = {}): Promise<void> {
  const intervalMs = options.intervalMs ?? DEFAULT_DAEMON_INTERVAL_MS;
  const signal = options.signal;

  while (!signal?.aborted) {
    let result: RunOnceResult | null = null;
    try {
      result = await runOnce(options);
    } catch (err) {
      logger.error({ err }, "Daemon cycle failed");
    }
    if (result) {
      console.log(formatRunOnceResult(result));
    }
    if (signal?.aborted) break;
    await sleep(intervalMs, signal);
  }
}
