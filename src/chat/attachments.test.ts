import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerRepository } from "../repositories/store.js";
import { createChatThread, deleteChatThread } from "./store.js";
import { createChatAttachment, getChatAttachment, readChatAttachment, reconcileChatAttachments, validateAttachment, MAX_ATTACHMENTS_PER_THREAD } from "./attachments.js";
import { attachmentPath } from "./attachment-storage.js";
import { openDatabase } from "../db/index.js";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "marshal-attachment-home-"));
  const checkout = mkdtempSync(join(tmpdir(), "marshal-attachment-checkout-"));
  const repository = registerRepository(checkout, home);
  const thread = createChatThread(repository.id, { agentId: "agent", agentVersion: "1" }, home);
  return { home, checkout, repository, thread };
}

describe("chat attachments", () => {
  it("accepts a real PNG signature and rejects spoofed content", () => {
    expect(validateAttachment({ type: "image/png", size: png.byteLength, bytes: png })).toBe("image/png");
    expect(() => validateAttachment({ type: "image/png", size: 4, bytes: new Uint8Array([1, 2, 3, 4]) })).toThrow("valid image");
  });

  it("rejects unsupported types and oversized files", () => {
    expect(() => validateAttachment({ type: "image/svg+xml", size: 4, bytes: png })).toThrow("Unsupported image type");
    expect(() => validateAttachment({ type: "image/png", size: 10 * 1024 * 1024 + 1, bytes: png })).toThrow("10 MiB");
  });

  it("writes and reads bytes in the repository ID namespace, not the checkout", () => {
    const { home, checkout, repository, thread } = fixture();
    const attachment = createChatAttachment(repository.id, thread.id, { type: "image/png", name: "proof.png", size: png.length, bytes: png }, home);
    const path = attachmentPath(repository.id, thread.id, (openDatabase(home).prepare("SELECT storage_key FROM chat_attachments WHERE id = ?").get(attachment.id) as { storage_key: string }).storage_key, home);
    expect(path).toContain(join(home, "repositories", repository.id, "attachments", thread.id));
    expect(path).not.toContain(checkout);
    expect(readChatAttachment(repository.id, thread.id, attachment.id, home).bytes).toEqual(Buffer.from(png));
    expect(attachment).not.toHaveProperty("storage_key");
  });

  it("enforces the per-thread quota from daemon metadata", () => {
    const { home, repository, thread } = fixture();
    const db = openDatabase(home);
    db.prepare("INSERT INTO chat_attachments (id, repository_id, thread_id, filename, mime_type, byte_size, storage_key) VALUES (?, ?, ?, ?, ?, ?, ?)").run(crypto.randomUUID(), repository.id, thread.id, "existing.png", "image/png", MAX_ATTACHMENTS_PER_THREAD, crypto.randomUUID());
    expect(() => createChatAttachment(repository.id, thread.id, { type: "image/png", name: "proof.png", size: png.length, bytes: png }, home)).toThrow("40 MiB");
  });

  it("removes newly written bytes when metadata insertion fails", () => {
    const { home, repository, thread } = fixture();
    const db = openDatabase(home);
    db.exec("CREATE TRIGGER reject_attachment_insert BEFORE INSERT ON chat_attachments BEGIN SELECT RAISE(ABORT, 'fixture insert failure'); END");
    expect(() => createChatAttachment(repository.id, thread.id, { type: "image/png", name: "proof.png", size: png.length, bytes: png }, home)).toThrow("fixture insert failure");
    const attachmentRoot = join(home, "repositories", repository.id, "attachments", thread.id);
    expect(existsSync(attachmentRoot) ? readdirSync(attachmentRoot) : []).toEqual([]);
  });

  it("keeps failed deletion metadata discoverable and retries cleanup", () => {
    const { home, repository, thread } = fixture();
    const attachment = createChatAttachment(repository.id, thread.id, { type: "image/png", name: "proof.png", size: png.length, bytes: png }, home);
    const storageKey = (openDatabase(home).prepare("SELECT storage_key FROM chat_attachments WHERE id = ?").get(attachment.id) as { storage_key: string }).storage_key;
    const path = attachmentPath(repository.id, thread.id, storageKey, home);
    rmSync(path);
    mkdirSync(path);
    expect(() => deleteChatThread(repository.id, thread.id, home)).toThrow();
    expect(getChatAttachment(repository.id, thread.id, attachment.id, home)).toBeTruthy();
    rmSync(path, { recursive: true });
    deleteChatThread(repository.id, thread.id, home);
    expect(existsSync(path)).toBe(false);
  });

  it("reconciles orphaned files and reports missing metadata without making them readable", () => {
    const { home, repository, thread } = fixture();
    const attachment = createChatAttachment(repository.id, thread.id, { type: "image/png", name: "proof.png", size: png.length, bytes: png }, home);
    const storageKey = (openDatabase(home).prepare("SELECT storage_key FROM chat_attachments WHERE id = ?").get(attachment.id) as { storage_key: string }).storage_key;
    const missingPath = attachmentPath(repository.id, thread.id, storageKey, home);
    rmSync(missingPath);
    const orphan = join(home, "repositories", repository.id, "attachments", thread.id, "orphan");
    writeFileSync(orphan, png);
    const result = reconcileChatAttachments(home);
    expect(result.missingMetadata).toHaveLength(1);
    expect(result.orphanedFiles).toContain(orphan);
    expect(existsSync(orphan)).toBe(false);
    expect(() => readChatAttachment(repository.id, thread.id, attachment.id, home)).toThrow("unavailable");
  });

  it("continues to work after checkout relocation and read-only checkout permissions", () => {
    const { home, checkout, repository, thread } = fixture();
    const moved = `${checkout}-moved`;
    renameSync(checkout, moved);
    mkdirSync(moved, { recursive: true });
    chmodSync(moved, 0o500);
    const attachment = createChatAttachment(repository.id, thread.id, { type: "image/png", name: "proof.png", size: png.length, bytes: png }, home);
    expect(readChatAttachment(repository.id, thread.id, attachment.id, home).bytes).toEqual(Buffer.from(png));
    rmSync(moved, { recursive: true, force: true });
  });

  it("rejects path-like durable storage keys", () => {
    const { home, repository, thread } = fixture();
    expect(() => attachmentPath(repository.id, thread.id, "../../outside", home)).toThrow();
    expect(() => attachmentPath(repository.id, thread.id, "outside.bin", home)).toThrow();
  });
});
