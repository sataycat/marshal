import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expandChatFileMentions, listChatFiles, readChatFile, safeChatPath } from "./files.js";

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "marshal-files-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  writeFileSync(join(root, "src", "app.ts"), "export const app = true;\n");
  writeFileSync(join(root, "src", "deep", "ignored.ts"), "ignored\n");
  writeFileSync(join(root, ".gitignore"), "src/deep/\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "init"], { cwd: root, stdio: "ignore" });
  writeFileSync(join(root, "src", "app.ts"), "changed\n");
  return root;
}

describe("chat files", () => {
  it("lists tracked, non-ignored files and marks git changes", () => {
    const root = repo();
    expect(listChatFiles(root, root)).toEqual(
      expect.arrayContaining([
        { path: "src", type: "directory", changed: true, touched: false },
        { path: "src/app.ts", type: "file", changed: true, touched: false },
      ]),
    );
    expect(listChatFiles(root, root).some((entry) => entry.path.includes("ignored"))).toBe(false);
  });

  it("returns an empty tree when the repository is unavailable", () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-files-no-git-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "app.ts"), "export const app = true;\n");

    expect(listChatFiles(root, root)).toEqual([]);
  });

  it("rejects traversal and expands only safe, bounded mentions", () => {
    const root = repo();
    expect(() => safeChatPath(root, "../outside")).toThrow();
    expect(readChatFile(root, "src/app.ts").content).toBe("changed\n");
    expect(expandChatFileMentions("Inspect @src/app.ts", root)).toContain(
      '<context file="src/app.ts">',
    );
    expect(expandChatFileMentions("Inspect @src/missing.ts", root)).toBe("Inspect @src/missing.ts");
  });
});
