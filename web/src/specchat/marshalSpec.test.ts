import { describe, it, expect } from "vitest";
import { extractMarshalSpec, MARSHAL_SPEC_FENCE } from "./marshalSpec";

describe("extractMarshalSpec", () => {
  it("extracts a single marshal-spec block", () => {
    const text = [
      "Here are the gaps I see.",
      "",
      "```" + MARSHAL_SPEC_FENCE,
      "# Goal",
      "Do a thing.",
      "```",
      "",
      "Let me know if that helps.",
    ].join("\n");
    expect(extractMarshalSpec(text)).toBe("# Goal\nDo a thing.");
  });

  it("returns null when no marshal-spec block exists", () => {
    expect(extractMarshalSpec("just prose\n```ts\ncode\n```")).toBeNull();
  });

  it("ignores an unclosed marshal-spec fence", () => {
    expect(extractMarshalSpec("```" + MARSHAL_SPEC_FENCE + "\nnever closed")).toBeNull();
  });

  it("ignores other fenced code blocks with different info strings", () => {
    const text = [
      "```js",
      "const x = 1;",
      "```",
      "```" + MARSHAL_SPEC_FENCE,
      "## Goal",
      "Do it.",
      "```",
    ].join("\n");
    expect(extractMarshalSpec(text)).toBe("## Goal\nDo it.");
  });

  it("uses the first marshal-spec block when multiple are present", () => {
    const text = [
      "```" + MARSHAL_SPEC_FENCE,
      "first",
      "```",
      "```" + MARSHAL_SPEC_FENCE,
      "second",
      "```",
    ].join("\n");
    expect(extractMarshalSpec(text)).toBe("first");
  });

  it("treats the info string as trimmed (no trailing spaces)", () => {
    const text = ["```" + MARSHAL_SPEC_FENCE + "  ", "body", "```"].join("\n");
    expect(extractMarshalSpec(text)).toBe("body");
  });

  it("preserves internal blank lines in the block content", () => {
    const text = ["```" + MARSHAL_SPEC_FENCE, "## Goal", "", "Do it.", "```"].join("\n");
    expect(extractMarshalSpec(text)).toBe("## Goal\n\nDo it.");
  });
});
