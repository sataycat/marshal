import { describe, it, expect } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("resolves to an HTML string", async () => {
    const out = await renderMarkdown("# Hello");
    expect(out).toContain("<h1>");
    expect(out).toContain("Hello");
  });

  it("produces identical output across calls (caches the resolved module)", async () => {
    const a = await renderMarkdown("**bold** and `code`");
    const b = await renderMarkdown("**bold** and `code`");
    expect(b).toBe(a);
  });

  it("treats null/empty input as empty markdown", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await renderMarkdown(null as any)).toBe("");
    expect(await renderMarkdown("")).toBe("");
  });

  it("renders GFM tables", async () => {
    const src = "| a | b |\n| - | - |\n| 1 | 2 |";
    const out = await renderMarkdown(src);
    expect(out).toContain("<table>");
  });
});
