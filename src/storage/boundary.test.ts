import { existsSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { registerRepository } from "../repositories/store.js";
import { listChatFiles, readChatFile } from "../chat/files.js";
import { inspectStorageBoundary } from "./layout.js";

describe("daemon storage boundary", () => {
  it("supports non-mutating reads from a registered read-only checkout without creating .marshal", () => {
    const home = mkdtempSync(join(tmpdir(), "marshal-boundary-home-"));
    const checkout = mkdtempSync(join(tmpdir(), "marshal-boundary-checkout-"));
    execFileSync("git", ["init", "-q", checkout]);
    writeFileSync(join(checkout, "README.md"), "read-only\n");
    execFileSync("git", ["-C", checkout, "add", "README.md"]);
    execFileSync("git", ["-C", checkout, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "init"]);
    const repository = registerRepository(checkout, home);
    chmodSync(checkout, 0o500);
    try {
      expect(listChatFiles(checkout, checkout)).toEqual(expect.arrayContaining([{ path: "README.md", type: "file", changed: false, touched: false }]));
      expect(readChatFile(checkout, "README.md").content).toBe("read-only\n");
      expect(existsSync(join(checkout, ".marshal"))).toBe(false);
      expect(inspectStorageBoundary(home, [repository.id]).root).toBe(home);
    } finally {
      chmodSync(checkout, 0o700);
    }
  });

  it("keeps ephemeral checkout reads separate from daemon state", () => {
    const home = mkdtempSync(join(tmpdir(), "marshal-ephemeral-home-"));
    const checkout = mkdtempSync(join(tmpdir(), "marshal-ephemeral-checkout-"));
    writeFileSync(join(checkout, "input.txt"), "ephemeral\n");
    expect(readFileSync(join(checkout, "input.txt"), "utf8")).toBe("ephemeral\n");
    expect(existsSync(join(checkout, ".marshal"))).toBe(false);
    expect(existsSync(join(home, "marshal.db"))).toBe(false);
  });
});
