import { logger } from "../logger.js";
import { runOnce, type RunOnceOptions, type RunOnceResult } from "./orchestrator.js";
import { publishDaemonCycleComplete, publishDaemonIdle, type EventBus } from "./bus.js";
import { repositoryRoot, listRepositories } from "../repositories/store.js";
import { reconcileInstallationOperations } from "../agents/store.js";
import { reconcileAgentActivations } from "../agents/activation.js";
import { getGlobalDir } from "./config.js";
import { openDatabase } from "../db/index.js";
import { reconcileChatAttachments } from "../chat/attachments.js";
import { reconcileWorktrees } from "../worktree/manager.js";

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
  const machineDir = options.machineDir ?? getGlobalDir();
  openDatabase(machineDir).close();
  reconcileInstallationOperations(machineDir);
  reconcileAgentActivations(machineDir, options.bus);
  reconcileChatAttachments(machineDir);
  reconcileWorktrees(machineDir);

  while (!signal?.aborted) {
    reconcileAgentActivations(machineDir, options.bus);
    reconcileChatAttachments(machineDir);
    let result: RunOnceResult | null = null;
    let published = false;
    try {
      const repositories = options.repositoryId ? listRepositories(machineDir).filter((repo) => repo.id === options.repositoryId) : listRepositories(machineDir);
      for (const repository of repositories) {
        result = await runOnce({ ...options, repositoryId: repository.id, root: repository.path });
        if (result) break;
      }
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
