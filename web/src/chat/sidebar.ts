import type { ChatThread } from "../types";

export interface ThreadProjectGroup {
  name: string;
  repoRoot: string;
  threads: ChatThread[];
}

export function projectName(repoRoot: string): string {
  const normalized = repoRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.split("/").pop() || repoRoot;
}

export function groupThreadsByProject(threads: ChatThread[]): ThreadProjectGroup[] {
  const groups = new Map<string, ThreadProjectGroup>();

  for (const thread of threads) {
    const group = groups.get(thread.repo_root);
    if (group) group.threads.push(thread);
    else
      groups.set(thread.repo_root, {
        name: projectName(thread.repo_root),
        repoRoot: thread.repo_root,
        threads: [thread],
      });
  }

  return [...groups.values()];
}
