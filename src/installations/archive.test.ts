import { gzipSync } from "node:zlib";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ARCHIVE_MAX_COMPRESSION_RATIO, ARCHIVE_MAX_ENTRIES, ARCHIVE_MAX_EXPANDED_BYTES } from "./archive.js";
import { extractArchive, extractTar } from "./archive.js";

function tar(name: string, body: Uint8Array, type = 48): Uint8Array { const h = new Uint8Array(512); h.set(new TextEncoder().encode(name), 0); h.set(new TextEncoder().encode((body.length.toString(8).padStart(11, "0") + "\0")), 124); h[156] = type; const out = new Uint8Array(1024 + Math.ceil(body.length / 512) * 512); out.set(h); out.set(body, 512); return out; }
function manyTarEntries(count: number): Uint8Array { const entry = tar("x", new Uint8Array()).subarray(0, 512); const out = new Uint8Array(count * 512 + 1024); for (let i = 0; i < count; i += 1) out.set(entry, i * 512); return out; }
describe("secure archive extraction", () => {
  it("extracts a safe tar archive", () => { const root = mkdtempSync(join(tmpdir(), "marshal-archive-")); extractArchive(gzipSync(tar("bin/probe", new TextEncoder().encode("ok"))), "tar.gz", root); expect(readFileSync(join(root, "bin/probe"), "utf8")).toBe("ok"); });
  it.each(["/etc/passwd", "../escape", "bin/../../escape"])("rejects unsafe path %s", (name) => expect(() => extractTar(tar(name, new Uint8Array([1])) , mkdtempSync(join(tmpdir(), "marshal-archive-")))).toThrow());
  it("rejects links", () => expect(() => extractTar(tar("link", new Uint8Array(), 50), mkdtempSync(join(tmpdir(), "marshal-archive-")))).toThrow(/link/));
  it("enforces entry, expanded-size, and compression-ratio limits before writing", () => {
    expect(() => extractTar(manyTarEntries(ARCHIVE_MAX_ENTRIES + 1), mkdtempSync(join(tmpdir(), "marshal-archive-")))).toThrow(/entry limit/);
    const oversized = tar("large", new Uint8Array());
    new DataView(oversized.buffer).setUint8(512 + 156, 48);
    new TextEncoder().encode((ARCHIVE_MAX_EXPANDED_BYTES + 1).toString(8).padStart(11, "0") + "\0").forEach((value, index) => { oversized[512 + 124 + index] = value; });
    expect(() => extractTar(oversized, mkdtempSync(join(tmpdir(), "marshal-archive-")))).toThrow(/expanded size/);
    const ratio = tar("ratio", new Uint8Array(ARCHIVE_MAX_COMPRESSION_RATIO * 2));
    expect(() => extractTar(ratio, mkdtempSync(join(tmpdir(), "marshal-archive-")), 1)).toThrow(/compression ratio/);
  });
});
