import { describe, expect, it } from "vitest";
import { fileLanguage, filterChatFiles } from "./fileTree";

describe("file tree helpers", () => {
  const files = [{ path: "src/app.ts", type: "file" as const, changed: false, touched: false }, { path: "README.md", type: "file" as const, changed: false, touched: false }];
  it("filters by path and maps common languages", () => {
    expect(filterChatFiles(files, "APP")).toEqual([files[0]]);
    expect(fileLanguage("src/view.tsx")).toBe("tsx");
    expect(fileLanguage("README.md")).toBe("md");
  });
});
