import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getGlobalDir, getRepoStateDir, initRepoState } from "../src/daemon/config.js";
import { getDbPath, openDb } from "../src/db/index.js";
import { openMachineDb } from "../src/storage/machine.js";
import { listTasks } from "../src/tasks/store.js";

describe("config and db bootstrap", () => {
  it("creates repo state directory", () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-"));
    initRepoState(root);
    expect(getRepoStateDir(root)).toEqual(join(root, ".marshal"));
  });

  it("creates a sqlite db and returns an empty task list", () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-"));
    const db = openDb(root);
    expect(getDbPath(root)).toEqual(join(root, ".marshal", "state.db"));
    expect(listTasks(root)).toEqual([]);
    db.close();
  });

  it("isolates machine databases by MARSHAL_HOME", () => {
    const firstHome = getGlobalDir();
    const first = openMachineDb();
    first.prepare("INSERT INTO machine_preferences (key, value) VALUES (?, ?)").run(
      "test-isolation",
      "written",
    );
    first.close();

    const secondHome = mkdtempSync(join(tmpdir(), "marshal-machine-isolation-"));
    try {
      process.env.MARSHAL_HOME = secondHome;
      const second = openMachineDb();
      expect(
        second.prepare("SELECT value FROM machine_preferences WHERE key = ?").get("test-isolation"),
      ).toBeUndefined();
      second.close();
      expect(getGlobalDir()).toBe(secondHome);
    } finally {
      process.env.MARSHAL_HOME = firstHome;
      rmSync(secondHome, { recursive: true, force: true });
    }
  });
});
