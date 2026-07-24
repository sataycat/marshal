import { existsSync, mkdtempSync, readlinkSync, rmSync, statSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertStoragePath,
  DEFAULT_MARSHAL_HOME,
  defaultMarshalHome,
  ensureStorageLayout,
  resolveMarshalHome,
  storageLayout,
  StoragePathError,
} from "./layout.js";

const originalMarshalHome = process.env.MARSHAL_HOME;
const createdPaths: string[] = [];

afterEach(() => {
  if (originalMarshalHome === undefined) delete process.env.MARSHAL_HOME;
  else process.env.MARSHAL_HOME = originalMarshalHome;
  for (const path of createdPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  createdPaths.push(path);
  return path;
}

describe("daemon storage layout", () => {
  it("resolves the default home to ~/.marshal", () => {
    delete process.env.MARSHAL_HOME;
    expect(DEFAULT_MARSHAL_HOME).toBe(resolve(homedir(), ".marshal"));
    expect(defaultMarshalHome()).toBe(resolve(homedir(), ".marshal"));
    expect(resolveMarshalHome()).toBe(resolve(homedir(), ".marshal"));
  });

  it("accepts absolute and relative MARSHAL_HOME overrides", () => {
    const absolute = tempRoot("marshal-layout-absolute-");
    process.env.MARSHAL_HOME = absolute;
    expect(storageLayout().root).toBe(resolve(absolute));

    const relativeName = `marshal-layout-relative-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    process.env.MARSHAL_HOME = relativeName;
    const expected = resolve(relativeName);
    expect(resolveMarshalHome()).toBe(expected);
    createdPaths.push(expected);
  });

  it("creates the daemon-owned directories beneath the root", () => {
    const root = join(tempRoot("marshal-layout-create-parent-"), "nested-home");
    createdPaths.push(root);
    const layout = ensureStorageLayout(root);

    expect(layout.databasePath).toBe(join(layout.root, "marshal.db"));
    expect(layout.daemonPidPath).toBe(join(layout.root, "daemon.pid"));
    expect(layout.daemonPortPath).toBe(join(layout.root, "daemon.port"));

    for (const directory of [
      layout.root,
      layout.registryDirectory,
      layout.installationsDirectory,
      layout.credentialsDirectory,
      layout.repositoriesDirectory,
      layout.logsDirectory,
      layout.temporaryDirectory,
    ]) {
      expect(existsSync(directory)).toBe(true);
      expect(statSync(directory).isDirectory()).toBe(true);
      expect(relative(layout.root, directory).startsWith("..")).toBe(false);
    }
    expect(existsSync(layout.databasePath)).toBe(false);
  });

  it("keeps sensitive storage directories private", () => {
    const layout = ensureStorageLayout(tempRoot("marshal-layout-permissions-"));
    expect(statSync(layout.root).mode & 0o777).toBe(0o700);
    expect(statSync(layout.credentialsDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(layout.temporaryDirectory).mode & 0o777).toBe(0o700);
  });

  it("validates namespace components and contains every resolved path", () => {
    const root = tempRoot("marshal-layout-containment-");
    const layout = storageLayout(root);
    const installation = layout.installationDirectory("@scope/agent", "1.2.3", "installation-id");
    const repository = layout.repositoryNamespace("repository-id");

    expect(installation.startsWith(`${resolve(root)}${process.platform === "win32" ? "\\" : "/"}`)).toBe(true);
    expect(repository.worktreesDirectory.startsWith(resolve(root))).toBe(true);
    expect(() => layout.installationDirectory("../escape", "1.0.0", "id")).toThrow(StoragePathError);
    expect(() => layout.installationDirectory("agent", "../escape", "id")).toThrow(StoragePathError);
    expect(() => layout.repositoryNamespace("../escape")).toThrow(StoragePathError);
    expect(() => assertStoragePath(root, resolve(root, "..", "outside"))).toThrow(StoragePathError);
  });

  it("rejects a daemon namespace redirected by a symlink", () => {
    const root = tempRoot("marshal-layout-symlink-");
    const outside = tempRoot("marshal-layout-outside-");
    symlinkSync(outside, join(root, "agents"), "junction");
    expect(readlinkSync(join(root, "agents"))).toBe(outside);
    expect(() => storageLayout(root)).toThrow(/symlink|escapes/i);
  });
});
