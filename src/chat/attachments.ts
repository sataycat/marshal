import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { openRepositoryDb } from "../db/index.js";
import { getChatThread, type ChatThread } from "./store.js";
import { ensureRepositoryNamespace } from "../storage/layout.js";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_THREAD = 40 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;
export const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type ChatAttachmentMime = typeof ALLOWED_IMAGE_TYPES[number];

export interface ChatAttachment {
  id: string;
  repository_id: string;
  thread_id: string;
  filename: string;
  mime_type: ChatAttachmentMime;
  byte_size: number;
  created_at: string;
}

export class ChatAttachmentError extends Error {
  constructor(message: string, readonly code = "attachment_invalid") {
    super(message);
    this.name = "ChatAttachmentError";
  }
}

function attachmentDir(thread: ChatThread): string {
  return resolve(ensureRepositoryNamespace(thread.repository_id).attachmentsDirectory, thread.id);
}

function rowToAttachment(row: Record<string, unknown>): ChatAttachment {
  return { ...(row as unknown as ChatAttachment), repository_id: String(row.repository_id) };
}

function validSignature(mime: string, bytes: Uint8Array): boolean {
  if (mime === "image/png") return bytes.length >= 8 && bytes.slice(0, 8).every((v, i) => v === [137, 80, 78, 71, 13, 10, 26, 10][i]);
  if (mime === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "image/gif") { const header = new TextDecoder().decode(bytes.slice(0, 6)); return header === "GIF87a" || header === "GIF89a"; }
  if (mime === "image/webp") return bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
  return false;
}

export function validateAttachment(file: { type: string; size: number; bytes: Uint8Array }): ChatAttachmentMime {
  if (!ALLOWED_IMAGE_TYPES.includes(file.type as ChatAttachmentMime)) throw new ChatAttachmentError("Unsupported image type. Use PNG, JPEG, WebP, or GIF.", "unsupported_image");
  if (file.size <= 0 || file.size > MAX_ATTACHMENT_BYTES) throw new ChatAttachmentError("Image must be between 1 byte and 10 MiB.", "attachment_too_large");
  if (!validSignature(file.type, file.bytes)) throw new ChatAttachmentError("The uploaded file is not a valid image of its declared type.", "invalid_image");
  return file.type as ChatAttachmentMime;
}

function extensionFor(mime: ChatAttachmentMime): string {
  return mime === "image/jpeg" ? ".jpg" : `.${mime.slice("image/".length)}`;
}

export function createChatAttachment(
  repositoryId: string,
  threadId: string,
  file: { type: string; name: string; size: number; bytes: Uint8Array },
  machineDir?: string,
): ChatAttachment {
  const thread = getChatThread(repositoryId, threadId, machineDir);
  const db = openRepositoryDb(repositoryId, machineDir);
  const total = db.prepare("SELECT COALESCE(SUM(byte_size), 0) AS total FROM chat_attachments WHERE repository_id = ? AND thread_id = ?").get(repositoryId, threadId) as { total: number };
  if (total.total + file.size > MAX_ATTACHMENTS_PER_THREAD) throw new ChatAttachmentError("This thread has reached its 40 MiB image quota.", "attachment_quota");
  const mime = validateAttachment(file);
  const extension = extname(file.name).toLowerCase();
  if (extension && extension !== extensionFor(mime) && !(mime === "image/jpeg" && extension === ".jpeg")) throw new ChatAttachmentError("The file extension does not match its image type.", "invalid_image");
  const id = randomUUID();
  const storageName = `${id}.bin`;
  mkdirSync(attachmentDir(thread), { recursive: true, mode: 0o700 });
  writeFileSync(resolve(attachmentDir(thread), storageName), file.bytes, { mode: 0o600, flag: "wx" });
  try {
    db.prepare("INSERT INTO chat_attachments (id, repository_id, thread_id, filename, mime_type, byte_size, storage_name) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, repositoryId, threadId, file.name.slice(0, 200) || "image", mime, file.size, storageName);
  } catch (error) {
    unlinkSync(resolve(attachmentDir(thread), storageName));
    throw error;
  }
  return getChatAttachment(repositoryId, threadId, id, machineDir);
}

export function listChatAttachments(repositoryId: string, threadId: string, machineDir?: string): ChatAttachment[] {
  // Attachment metadata is owned by the thread's repository. Keep a
  // cross-repository lookup indistinguishable from a missing thread.
  getChatThread(repositoryId, threadId, machineDir);
  return (openRepositoryDb(repositoryId, machineDir).prepare("SELECT id, repository_id, thread_id, filename, mime_type, byte_size, created_at FROM chat_attachments WHERE repository_id = ? AND thread_id = ? ORDER BY created_at, id").all(repositoryId, threadId) as Record<string, unknown>[]).map(rowToAttachment);
}

export function getChatAttachment(repositoryId: string, threadId: string, id: string, machineDir?: string): ChatAttachment {
  getChatThread(repositoryId, threadId, machineDir);
  const row = openRepositoryDb(repositoryId, machineDir).prepare("SELECT id, repository_id, thread_id, filename, mime_type, byte_size, created_at FROM chat_attachments WHERE id = ? AND repository_id = ? AND thread_id = ?").get(id, repositoryId, threadId) as Record<string, unknown> | undefined;
  if (!row) throw new ChatAttachmentError("Attachment not found.", "attachment_not_found");
  return rowToAttachment(row);
}

export function readChatAttachment(repositoryId: string, threadId: string, id: string, machineDir?: string): { attachment: ChatAttachment; bytes: Buffer } {
  const attachment = getChatAttachment(repositoryId, threadId, id, machineDir);
  const thread = getChatThread(repositoryId, threadId, machineDir);
  const row = openRepositoryDb(repositoryId, machineDir).prepare("SELECT storage_name FROM chat_attachments WHERE id = ? AND repository_id = ? AND thread_id = ?").get(id, repositoryId, threadId) as { storage_name: string };
  if (!/^[0-9a-f-]+\.bin$/i.test(row.storage_name)) throw new ChatAttachmentError("Attachment storage is invalid.", "attachment_invalid");
  return { attachment, bytes: readFileSync(resolve(attachmentDir(thread), row.storage_name)) };
}
