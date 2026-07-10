export interface DiffStats {
  files: number;
  insertions: number;
  deletions: number;
}

export interface DiffResult {
  diff: string;
  stats: DiffStats;
}

export class DiffError extends Error {
  constructor(slug: string, message: string) {
    super(`Cannot diff task ${slug}: ${message}`);
    this.name = "DiffError";
  }
}

export class MergeError extends Error {
  constructor(slug: string, message: string) {
    super(`Cannot merge task ${slug}: ${message}`);
    this.name = "MergeError";
  }
}

export interface MergeResult {
  commitSha: string;
}

export function parseDiffStats(diff: string): DiffStats {
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      files++;
      continue;
    }
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.length === 0) continue;
    const ch = line.charCodeAt(0);
    if (ch === 0x2b /* + */) {
      insertions++;
    } else if (ch === 0x2d /* - */) {
      deletions++;
    }
  }
  return { files, insertions, deletions };
}
