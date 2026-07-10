export interface DiffHunkLine {
  type: "add" | "del" | "context";
  text: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLen: number;
  newStart: number;
  newLen: number;
  lines: DiffHunkLine[];
}

export interface DiffFile {
  oldPath: string;
  newPath: string;
  hunks: DiffHunk[];
}

export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = diff.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.startsWith("diff --git ")) {
      i++;
      continue;
    }
    // a/<path> b/<path>
    const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
    if (m === null) {
      i++;
      continue;
    }
    const file: DiffFile = { oldPath: m[1], newPath: m[2], hunks: [] };
    files.push(file);
    i++;
    // Skip header lines until we hit a hunk marker.
    while (i < lines.length && !lines[i].startsWith("@@ ") && !lines[i].startsWith("diff --git ")) {
      i++;
    }
    while (i < lines.length && lines[i].startsWith("@@ ")) {
      const hunkMatch = lines[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (hunkMatch === null) {
        i++;
        continue;
      }
      const hunk: DiffHunk = {
        oldStart: parseInt(hunkMatch[1], 10),
        oldLen: hunkMatch[2] === undefined ? 1 : parseInt(hunkMatch[2], 10),
        newStart: parseInt(hunkMatch[3], 10),
        newLen: hunkMatch[4] === undefined ? 1 : parseInt(hunkMatch[4], 10),
        lines: [],
      };
      file.hunks.push(hunk);
      i++;
      // Collect body lines until next hunk, next file, or end.
      while (i < lines.length) {
        const body = lines[i];
        if (body.startsWith("@@ ") || body.startsWith("diff --git ")) break;
        if (body.startsWith("\\ ")) {
          // "\ No newline at end of file" marker; ignore for line counting.
          i++;
          continue;
        }
        if (body === "") {
          // Treat trailing/empty lines as context to preserve structure.
          if (hunk.lines.length === 0) {
            i++;
            continue;
          }
          hunk.lines.push({ type: "context", text: "" });
          i++;
          continue;
        }
        const ch = body[0];
        if (ch === "+") {
          hunk.lines.push({ type: "add", text: body.slice(1) });
        } else if (ch === "-") {
          hunk.lines.push({ type: "del", text: body.slice(1) });
        } else {
          hunk.lines.push({ type: "context", text: ch === " " ? body.slice(1) : body });
        }
        i++;
      }
    }
  }
  return files;
}
