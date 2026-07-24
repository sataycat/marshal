import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  getSelectedRepository,
  getRepository,
  listRepositories,
  registerRepository,
  reconnectRepository,
  removeRepository,
  selectRepository,
} from "./store.js";
import { createChatThread } from "../chat/store.js";
import { createTask } from "../tasks/store.js";
import { RunLog } from "../daemon/run-log.js";
import { openDatabase } from "../db/index.js";
import { resolveRepositoryContext, RepositoryContextError } from "./context.js";

function repo(): string {
  const path = mkdtempSync(join(tmpdir(), "marshal-repo-"));
  execFileSync("git", ["init", "-q", path]);
  return path;
}

describe("repository store", () => {
  it("canonicalizes and persists selection without touching the checkout", () => {
    const machine = mkdtempSync(join(tmpdir(), "marshal-machine-"));
    const path = repo();
    const registered = registerRepository(join(path, "."), machine);
    expect(registerRepository).toBeDefined();
    expect(listRepositories(machine)).toHaveLength(1);
    expect(selectRepository(registered.id, machine).path).toBe(realpathSync(path));
    expect(getSelectedRepository(machine)?.id).toBe(registered.id);
    expect(removeRepository(registered.id, machine)).toBe(true);
    expect(listRepositories(machine)).toMatchObject([
      { id: registered.id, registration_status: "unregistered", checkout_status: "unregistered" },
    ]);
  });

  it("retains history and namespace ownership across unregister and reconnect", () => {
    const machine = mkdtempSync(join(tmpdir(), "marshal-machine-retained-"));
    const path = repo();
    const registered = registerRepository(path, machine);
    const namespace = join(machine, "repositories", registered.id);
    mkdirSync(namespace, { recursive: true });
    writeFileSync(join(namespace, "history.txt"), "retained");
    removeRepository(registered.id, machine);
    expect(getSelectedRepository(machine)).toBeUndefined();
    expect(listRepositories(machine)[0].id).toBe(registered.id);
    expect(reconnectRepository(registered.id, path, machine)).toMatchObject({
      id: registered.id,
      registration_status: "registered",
      checkout_status: "available",
    });
    expect(readFileSync(join(namespace, "history.txt"), "utf8")).toBe("retained");
    expect(selectRepository(registered.id, machine).id).toBe(registered.id);
  });

  it("retains threads and runs, blocks source work while missing, and preserves FK integrity", () => {
    const machine = mkdtempSync(join(tmpdir(), "marshal-machine-history-"));
    const path = repo();
    const registered = registerRepository(path, machine);
    const thread = createChatThread(registered.id, { agentId: "agent", agentVersion: "1" }, machine);
    const task = createTask({ repositoryId: registered.id, slug: "retained", title: "Retained" }, machine);
    const run = new RunLog(registered.id, machine).startRun(task.id, "builder", "agent", "prompt");
    removeRepository(registered.id, machine);
    expect(getRepository(registered.id, machine)).toMatchObject({ registration_status: "unregistered" });
    expect(new RunLog(registered.id, machine).getRun(run)).toBeDefined();
    expect(thread.repository_id).toBe(registered.id);
    expect(() => resolveRepositoryContext(registered.id, machine)).toThrowError(RepositoryContextError);
    expect(() => resolveRepositoryContext(registered.id, machine)).toThrow(/source-dependent actions/);
    const db = openDatabase(machine);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM chat_threads WHERE repository_id = ?").get(registered.id)).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM runs WHERE repository_id = ?").get(registered.id)).toEqual({ count: 1 });
    const moved = `${path}-moved`;
    renameSync(path, moved);
    expect(getRepository(registered.id, machine)?.checkout_status).toBe("unregistered");
    reconnectRepository(registered.id, moved, machine);
    expect(selectRepository(registered.id, machine).id).toBe(registered.id);
    rmSync(moved, { recursive: true, force: true });
  });

  it("reports a deleted registered checkout as unavailable", () => {
    const machine = mkdtempSync(join(tmpdir(), "marshal-machine-missing-"));
    const path = repo();
    const registered = registerRepository(path, machine);
    rmSync(path, { recursive: true, force: true });
    expect(getRepository(registered.id, machine)).toMatchObject({
      registration_status: "registered",
      checkout_status: "missing",
    });
    expect(() => selectRepository(registered.id, machine)).toThrow(/unavailable/);
  });

  it("rejects invalid paths and equivalent symlinks", () => {
    const machine = mkdtempSync(join(tmpdir(), "marshal-machine-"));
    const path = repo();
    registerRepository(path, machine);
    const link = join(mkdtempSync(join(tmpdir(), "marshal-link-")), "repo");
    symlinkSync(path, link);
    expect(() => registerRepository(link, machine)).toThrow(/already registered/);
    const file = join(machine, "file");
    writeFileSync(file, "x");
    expect(() => registerRepository(file, machine)).toThrow(/not a directory/);
    const plain = mkdtempSync(join(tmpdir(), "marshal-plain-"));
    mkdirSync(join(plain, "nested"));
    expect(registerRepository(plain, machine)).toMatchObject({
      path: realpathSync(plain),
      name: basename(plain),
    });
  });
});
