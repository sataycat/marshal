import { describe, it, expect } from "vitest";
import { parseUnifiedDiff } from "./parseDiff";

const SAMPLE = [
  "diff --git a/foo.txt b/foo.txt",
  "index 1111111..2222222 100644",
  "--- a/foo.txt",
  "+++ b/foo.txt",
  "@@ -1,2 +1,3 @@",
  " context",
  "-old line",
  "+new line",
  "+another",
  "diff --git a/bar.txt b/bar.txt",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/bar.txt",
  "@@ -0,0 +1 @@",
  "+brand new",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("parses two files with their hunks", () => {
    const files = parseUnifiedDiff(SAMPLE);
    expect(files).toHaveLength(2);
    expect(files[0].oldPath).toBe("foo.txt");
    expect(files[0].newPath).toBe("foo.txt");
    expect(files[0].hunks).toHaveLength(1);
    expect(files[0].hunks[0].oldStart).toBe(1);
    expect(files[0].hunks[0].newStart).toBe(1);
    expect(files[0].hunks[0].lines.map((l) => l.type)).toEqual(["context", "del", "add", "add"]);
    expect(files[0].hunks[0].lines.map((l) => l.text)).toEqual([
      "context",
      "old line",
      "new line",
      "another",
    ]);
    expect(files[1].newPath).toBe("bar.txt");
    expect(files[1].hunks[0].lines).toEqual([{ type: "add", text: "brand new" }]);
  });

  it("returns an empty array for an empty diff", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  it("handles a hunk header with no length (single-line)", () => {
    const diff = ["diff --git a/a b/a", "--- a/a", "+++ b/a", "@@ -1 +1 @@", "-x", "+y"].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files[0].hunks[0].oldLen).toBe(1);
    expect(files[0].hunks[0].newLen).toBe(1);
  });

  it("ignores the no-newline marker", () => {
    const diff = [
      "diff --git a/a b/a",
      "--- a/a",
      "+++ b/a",
      "@@ -1 +1 @@",
      "-x",
      "\\ No newline at end of file",
      "+y",
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files[0].hunks[0].lines.map((l) => l.text)).toEqual(["x", "y"]);
  });
});
