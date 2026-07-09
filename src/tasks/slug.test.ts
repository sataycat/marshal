import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createTask } from "./store.js";
import { generateUniqueSlug, slugifyTitle } from "./slug.js";

describe("slugifyTitle", () => {
  it("lowercases and hyphenates a simple title", () => {
    expect(slugifyTitle("Add Login Page")).toBe("add-login-page");
  });

  it("collapses runs of non-alphanumeric chars into a single hyphen", () => {
    expect(slugifyTitle("Fix   the  __bug!!")).toBe("fix-the-bug");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugifyTitle("---Edge Case---")).toBe("edge-case");
  });

  it("falls back to 'task' when the title is empty or has no usable chars", () => {
    expect(slugifyTitle("")).toBe("task");
    expect(slugifyTitle("!!! ???")).toBe("task");
  });

  it("preserves embedded numbers", () => {
    expect(slugifyTitle("Support HTTP/2 streams")).toBe("support-http-2-streams");
  });
});

describe("generateUniqueSlug", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "marshal-slug-"));
  });

  it("returns the bare slugified title when no collision exists", () => {
    expect(generateUniqueSlug("Add Greeting", root)).toBe("add-greeting");
  });

  it("appends -2 on the first collision", () => {
    createTask({ slug: "add-greeting", title: "First" }, root);
    expect(generateUniqueSlug("Add Greeting", root)).toBe("add-greeting-2");
  });

  it("keeps incrementing the suffix past multiple collisions", () => {
    createTask({ slug: "add-greeting", title: "First" }, root);
    createTask({ slug: "add-greeting-2", title: "Second" }, root);
    createTask({ slug: "add-greeting-3", title: "Third" }, root);
    expect(generateUniqueSlug("Add Greeting", root)).toBe("add-greeting-4");
  });

  it("ignores a stored slug that differs from the generated base", () => {
    createTask({ slug: "add-greeting-2", title: "Unrelated" }, root);
    expect(generateUniqueSlug("Add Greeting", root)).toBe("add-greeting");
  });
});