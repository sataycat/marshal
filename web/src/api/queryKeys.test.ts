import { describe, expect, it } from "vitest";
import { queryKeys } from "./queryKeys";

describe("query keys", () => {
  it("builds stable domain keys", () => {
    expect(queryKeys.task("demo")).toEqual(["task", "demo"]);
    expect(queryKeys.file("thread", "src/index.ts")).toEqual(["thread", null, "thread", "file", "src/index.ts"]);
    expect(queryKeys.threads(true)).toEqual(["threads", { archived: true }]);
  });
});
