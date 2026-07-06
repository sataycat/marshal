import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getRepoStateDir, initRepoState } from "../src/daemon/config.js";
import { getDbPath, openDb } from "../src/db/index.js";
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
});
