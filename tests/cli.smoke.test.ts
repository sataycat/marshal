import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const binPath = resolve(process.cwd(), "bin/marshal");

function run(args: string[], cwd?: string): { stdout: string; stderr: string } {
  const result = execFileSync("node", [binPath, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { stdout: result.toString(), stderr: "" };
}

describe("CLI smoke tests", () => {
  it("prints version with --version", () => {
    const { stdout } = run(["--version"]);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("initializes repo state with init", () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-"));
    const { stdout } = run(["init"], root);
    expect(stdout).toContain("Marshal initialized");
    expect(existsSync(join(root, ".marshal"))).toBe(true);
    expect(existsSync(join(root, ".marshal", "state.db"))).toBe(true);
  });

  it("lists no tasks with task list", () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-"));
    run(["init"], root);
    const { stdout } = run(["task", "list"], root);
    expect(stdout.trim()).toBe("No tasks.");
  });
});
