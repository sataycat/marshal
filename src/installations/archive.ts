import { createInflateRaw, gunzipSync, inflateRawSync } from "node:zlib";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";

export const ARCHIVE_MAX_ENTRIES = 1_000;
export const ARCHIVE_MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
export const ARCHIVE_MAX_COMPRESSION_RATIO = 100;

function safeEntry(name: string): string {
  if (!name || name.includes("\0") || name.startsWith("/") || /^[A-Za-z]:[\\/]/.test(name)) throw new Error("archive contains an absolute path");
  const clean = normalize(name.replaceAll("\\", "/"));
  if (clean === ".." || clean.startsWith(`..${"/"}`)) throw new Error("archive contains a traversal path");
  return clean;
}
function destination(root: string, name: string): string { const path = resolve(root, safeEntry(name)); if (relative(resolve(root), path).startsWith("..")) throw new Error("archive entry escapes installation root"); return path; }
function writeEntry(root: string, name: string, bytes: Uint8Array, directory = false): void {
  const path = destination(root, name); if (directory) { mkdirSync(path, { recursive: true }); return; }
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes);
}
function checkLimits(entries: number, expanded: number, compressed: number): void {
  if (entries > ARCHIVE_MAX_ENTRIES) throw new Error("archive entry limit exceeded");
  if (expanded > ARCHIVE_MAX_EXPANDED_BYTES) throw new Error("archive expanded size limit exceeded");
  if (compressed > 0 && expanded / compressed > ARCHIVE_MAX_COMPRESSION_RATIO) throw new Error("archive compression ratio limit exceeded");
}

export function extractTar(bytes: Uint8Array, root: string): void {
  let offset = 0; let entries = 0; let expanded = 0;
  while (offset + 512 <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + 512); offset += 512;
    if (header.every((value) => value === 0)) break;
    const name = new TextDecoder().decode(header.subarray(0, 100)).replace(/\0.*$/, "");
    const prefix = new TextDecoder().decode(header.subarray(345, 500)).replace(/\0.*$/, "");
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(new TextDecoder().decode(header.subarray(124, 136)).replace(/\0.*$/, "").trim() || "0", 8);
    const type = header[156]; entries++; expanded += size; checkLimits(entries, expanded, bytes.byteLength);
    if ([50, 49, 51, 52, 54].includes(type)) throw new Error("archive contains an unsupported link or device entry");
    if (![0, 48, 53].includes(type)) throw new Error("archive contains an unsupported entry");
    const payload = bytes.subarray(offset, offset + size); if (payload.byteLength !== size) throw new Error("archive entry is truncated");
    writeEntry(root, fullName, payload, type === 53); offset += Math.ceil(size / 512) * 512;
  }
}

export function extractZip(bytes: Uint8Array, root: string): void {
  let offset = 0; let entries = 0; let expanded = 0;
  while (offset + 4 <= bytes.byteLength) {
    const signature = bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
    if (signature === 0x04034b50) {
      const flags = bytes[offset + 6] | (bytes[offset + 7] << 8); const method = bytes[offset + 8] | (bytes[offset + 9] << 8);
      const compressed = bytes[offset + 18] | (bytes[offset + 19] << 8) | (bytes[offset + 20] << 16) | (bytes[offset + 21] << 24);
      const uncompressed = bytes[offset + 22] | (bytes[offset + 23] << 8) | (bytes[offset + 24] << 16) | (bytes[offset + 25] << 24);
      const nameLength = bytes[offset + 26] | (bytes[offset + 27] << 8); const extraLength = bytes[offset + 28] | (bytes[offset + 29] << 8);
      if (flags & 0x08) throw new Error("zip data descriptors are unsupported");
      const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength)); const start = offset + 30 + nameLength + extraLength;
      const data = bytes.subarray(start, start + compressed); if (data.byteLength !== compressed) throw new Error("zip entry is truncated");
      const content = method === 0 ? data : method === 8 ? inflateRawSync(data) : (() => { throw new Error("zip compression method is unsupported"); })();
      entries++; expanded += uncompressed; checkLimits(entries, expanded, bytes.byteLength); if (content.byteLength !== uncompressed) throw new Error("zip entry size mismatch");
      writeEntry(root, name, content, name.endsWith("/")); offset = start + compressed;
    } else if (signature === 0x02014b50 || signature === 0x06054b50) break;
    else throw new Error("invalid zip archive");
  }
}

export function extractArchive(bytes: Uint8Array, format: "tar.gz" | "tgz" | "zip", root: string): void {
  mkdirSync(root, { recursive: true });
  if (format === "zip") extractZip(bytes, root); else extractTar(gunzipSync(bytes), root);
}
