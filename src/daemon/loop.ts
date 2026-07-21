import { logger } from "../logger.js";
import { runOnce, type RunOnceOptions, type RunOnceResult } from "./orchestrator.js";
import { publishDaemonCycleComplete, publishDaemonIdle, type EventBus } from "./bus.js";
import { repositoryRoot } from "../repositories/store.js";
import { reconcileInstallationOperations } from "../agents/store.js";
import { reconcileAgentActivations } from "../agents/activation.js";
import { GLOBAL_DIR } from "./config.js";

export const DEFAULT_DAEMON_INTERVAL_MS = 5000;

export interface StartDaemonOptions extends RunOnceOptions {
  intervalMs?: number;
  signal?: AbortSignal;
  bus?: EventBus;
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
  const machineDir = options.machineDir ?? GLOBAL_DIR;
  reconcileInstallationOperations(machineDir);
  reconcileAgentActivations(machineDir, options.bus);

  while (!signal?.aborted) {
    reconcileAgentActivations(machineDir, options.bus);
    let result: RunOnceResult | null = null;
    let published = false;
    try {
      const root = options.root ?? repositoryRoot();
      if (!root) {
        if (options.bus) publishDaemonIdle(options.bus);
        await sleep(intervalMs, signal);
        continue;
      }
      result = await runOnce({ ...options, root });
    } catch (err) {
      logger.error({ err }, "Daemon cycle failed");
      published = true;
    }
    if (result) {
      console.log(formatRunOnceResult(result));
      if (options.bus) publishDaemonCycleComplete(options.bus);
      published = true;
    } else if (!published && options.bus) {
      publishDaemonIdle(options.bus);
      published = true;
    }
    if (signal?.aborted) break;
    await sleep(intervalMs, signal);
  }
}
