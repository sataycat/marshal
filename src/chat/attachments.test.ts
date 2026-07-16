import { describe, expect, it } from "vitest";
import { validateAttachment } from "./attachments.js";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

describe("chat attachments", () => {
  it("accepts a real PNG signature and rejects spoofed content", () => {
    expect(validateAttachment({ type: "image/png", size: png.byteLength, bytes: png })).toBe("image/png");
    expect(() => validateAttachment({ type: "image/png", size: 4, bytes: new Uint8Array([1, 2, 3, 4]) })).toThrow("valid image");
  });

  it("rejects unsupported types and oversized files", () => {
    expect(() => validateAttachment({ type: "image/svg+xml", size: 4, bytes: png })).toThrow("Unsupported image type");
    expect(() => validateAttachment({ type: "image/png", size: 10 * 1024 * 1024 + 1, bytes: png })).toThrow("10 MiB");
  });
});
