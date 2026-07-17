import { describe, expect, it } from "vitest";
import type { ChatThread } from "../types";
import { groupThreadsByProject, projectName } from "./sidebar";

function thread(id: string, repoRoot: string): ChatThread {
  return {
    id,
    repo_root: repoRoot,
    cwd: repoRoot,
    agent_id: "builder",
    title: id,
    status: "draft",
    archived: false,
    pinned: false,
    task_slug: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    last_message_at: null,
    scratch_markdown: "",
  };
}

describe("chat sidebar grouping", () => {
  it("uses the final path segment as the project name", () => {
    expect(projectName("/Users/chong/code/marshal/")).toBe("marshal");
    expect(projectName("C:\\code\\openchamber")).toBe("openchamber");
  });

  it("groups threads by repo while preserving first-seen order", () => {
    const groups = groupThreadsByProject([
      thread("marshal-1", "/code/marshal"),
      thread("codex-1", "/code/codex"),
      thread("marshal-2", "/code/marshal"),
    ]);

    expect(groups.map((group) => group.name)).toEqual(["marshal", "codex"]);
    expect(groups[0]?.threads.map((item) => item.id)).toEqual(["marshal-1", "marshal-2"]);
  });
});
