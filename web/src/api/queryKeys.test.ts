import { describe, expect, it } from "vitest";
import { queryKeys } from "./queryKeys";

describe("query keys", () => {
  it("builds stable domain keys", () => {
    expect(queryKeys.task("demo")).toEqual(["task", null, "demo"]);
    expect(queryKeys.file("thread", "src/index.ts")).toEqual(["thread", null, "thread", "file", "src/index.ts"]);
    expect(queryKeys.threads(true)).toEqual(["threads", null, { archived: true }]);
    expect(queryKeys.attachments("thread", "repository-a")).toEqual([
      "thread",
      "repository-a",
      "thread",
      "attachments",
    ]);
    expect(queryKeys.attachments("thread", "repository-a")).not.toEqual(
      queryKeys.attachments("thread", "repository-b"),
    );
  });
});
