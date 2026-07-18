import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { getSelectedRepository, listRepositories, registerRepository, removeRepository, selectRepository } from "./store.js";

function repo(): string { const path = mkdtempSync(join(tmpdir(), "marshal-repo-")); execFileSync("git", ["init", "-q", path]); return path; }

describe("repository store", () => {
  it("canonicalizes and persists selection without touching the checkout", () => {
    const machine = mkdtempSync(join(tmpdir(), "marshal-machine-"));
    const path = repo();
    const registered = registerRepository(join(path, "."), machine);
    expect(registerRepository).toBeDefined();
    expect(listRepositories(machine)).toHaveLength(1);
    expect(selectRepository(registered.id, machine).path).toBe(path);
    expect(getSelectedRepository(machine)?.id).toBe(registered.id);
    expect(removeRepository(registered.id, machine)).toBe(true);
    expect(listRepositories(machine)).toHaveLength(0);
  });

  it("rejects invalid paths and equivalent symlinks", () => {
    const machine = mkdtempSync(join(tmpdir(), "marshal-machine-"));
    const path = repo();
    registerRepository(path, machine);
    const link = join(mkdtempSync(join(tmpdir(), "marshal-link-")), "repo");
    symlinkSync(path, link);
    expect(() => registerRepository(link, machine)).toThrow(/already registered/);
    const file = join(machine, "file"); writeFileSync(file, "x");
    expect(() => registerRepository(file, machine)).toThrow(/not a directory/);
    const plain = mkdtempSync(join(tmpdir(), "marshal-plain-")); mkdirSync(join(plain, "nested"));
    expect(() => registerRepository(plain, machine)).toThrow(/not a git/);
  });
});
