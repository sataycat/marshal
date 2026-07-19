import { gzipSync } from "node:zlib";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractArchive, extractTar } from "./archive.js";

function tar(name: string, body: Uint8Array, type = 48): Uint8Array { const h = new Uint8Array(512); h.set(new TextEncoder().encode(name), 0); h.set(new TextEncoder().encode((body.length.toString(8).padStart(11, "0") + "\0")), 124); h[156] = type; const out = new Uint8Array(1024 + Math.ceil(body.length / 512) * 512); out.set(h); out.set(body, 512); return out; }
describe("secure archive extraction", () => {
  it("extracts a safe tar archive", () => { const root = mkdtempSync(join(tmpdir(), "marshal-archive-")); extractArchive(gzipSync(tar("bin/probe", new TextEncoder().encode("ok"))), "tar.gz", root); expect(readFileSync(join(root, "bin/probe"), "utf8")).toBe("ok"); });
  it.each(["/etc/passwd", "../escape", "bin/../../escape"])("rejects unsafe path %s", (name) => expect(() => extractTar(tar(name, new Uint8Array([1])) , mkdtempSync(join(tmpdir(), "marshal-archive-")))).toThrow());
  it("rejects links", () => expect(() => extractTar(tar("link", new Uint8Array(), 50), mkdtempSync(join(tmpdir(), "marshal-archive-")))).toThrow(/link/));
});
