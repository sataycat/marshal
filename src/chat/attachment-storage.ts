import { lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { assertStoragePath, storageLayout, StoragePathError } from "../storage/layout.js";

export interface AttachmentStorageRow {
  repository_id: string;
  thread_id: string;
  storage_key: string;
}

export interface AttachmentReconciliation {
  orphanedFiles: string[];
  missingMetadata: Array<{ repository_id: string; thread_id: string; storage_key: string }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function newAttachmentStorageKey(): string {
  return randomUUID();
}

function safeId(value: string, label: string): string {
  if (!UUID.test(value)) throw new StoragePathError(`${label} must be a daemon-generated UUID`);
  return value;
}

function safeStorageKey(value: string): string {
  // Storage keys are opaque daemon-generated names.  Do not accept extensions,
  // separators, or user-controlled path syntax from durable metadata.
  if (!UUID.test(value)) throw new StoragePathError("Attachment storage key is invalid");
  return value;
}

export function attachmentDirectory(repositoryId: string, threadId: string, machineDir?: string): string {
  safeId(repositoryId, "Repository ID");
  safeId(threadId, "Thread ID");
  const namespace = storageLayout(machineDir).repositoryNamespace(repositoryId);
  return resolve(namespace.attachmentsDirectory, threadId);
}

export function attachmentPath(
  repositoryId: string,
  threadId: string,
  storageKey: string,
  machineDir?: string,
): string {
  const directory = attachmentDirectory(repositoryId, threadId, machineDir);
  const key = safeStorageKey(storageKey);
  const candidate = assertStoragePath(machineDir, resolve(directory, key));
  const relative = candidate.slice(directory.length + 1);
  if (!relative || relative.includes("/") || relative.includes("\\"))
    throw new StoragePathError("Attachment storage key escapes its namespace");
  return candidate;
}

export function writeAttachmentBytes(
  repositoryId: string,
  threadId: string,
  storageKey: string,
  bytes: Uint8Array,
  machineDir?: string,
): string {
  const path = attachmentPath(repositoryId, threadId, storageKey, machineDir);
  const directory = attachmentDirectory(repositoryId, threadId, machineDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  return path;
}

export function removeAttachmentFile(
  repositoryId: string,
  threadId: string,
  storageKey: string,
  machineDir?: string,
): boolean {
  const path = attachmentPath(repositoryId, threadId, storageKey, machineDir);
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function removeAttachmentTree(
  repositoryId: string,
  threadId: string,
  storageKeys: string[],
  machineDir?: string,
): void {
  // Do not remove the metadata until every file has been removed.  A failed
  // unlink therefore leaves the thread and its metadata available for a
  // later maintenance retry.
  for (const storageKey of storageKeys) removeAttachmentFile(repositoryId, threadId, storageKey, machineDir);
}

export function readAttachmentBytes(
  repositoryId: string,
  threadId: string,
  storageKey: string,
  machineDir?: string,
): Buffer {
  return readFileSync(attachmentPath(repositoryId, threadId, storageKey, machineDir));
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function scanAttachmentDirectory(
  directory: string,
  expected: Set<string>,
  orphanedFiles: string[],
): void {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) {
      unlinkSync(path);
      orphanedFiles.push(path);
      continue;
    }
    if (entry.isDirectory()) {
      scanAttachmentDirectory(path, expected, orphanedFiles);
      try {
        rmdirSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      continue;
    }
    if (!expected.has(path)) {
      unlinkSync(path);
      orphanedFiles.push(path);
    }
  }
}

/**
 * Reconcile only the daemon-owned attachment namespace.  Missing metadata is
 * reported, not silently made readable: normal reads still require the
 * repository/thread composite lookup and the exact opaque storage key.
 */
export function reconcileAttachmentFiles(
  rows: AttachmentStorageRow[],
  machineDir?: string,
): AttachmentReconciliation {
  const layout = storageLayout(machineDir);
  const expected = new Set<string>();
  const missingMetadata: AttachmentReconciliation["missingMetadata"] = [];
  for (const row of rows) {
    try {
      const path = attachmentPath(row.repository_id, row.thread_id, row.storage_key, machineDir);
      expected.add(path);
      try {
        if (!lstatSync(path).isFile() || isSymlink(path)) missingMetadata.push(row);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") missingMetadata.push(row);
        else throw error;
      }
    } catch {
      // Invalid durable metadata is intentionally treated as missing.  It is
      // never converted into a path or used to relax repository authorization.
      missingMetadata.push(row);
    }
  }

  const orphanedFiles: string[] = [];
  if (lstatSync(layout.repositoriesDirectory, { throwIfNoEntry: false })?.isDirectory()) {
    for (const repositoryEntry of readdirSync(layout.repositoriesDirectory, { withFileTypes: true })) {
      if (repositoryEntry.isSymbolicLink() || !repositoryEntry.isDirectory()) continue;
      const attachments = resolve(layout.repositoriesDirectory, repositoryEntry.name, "attachments");
      const attachmentStat = lstatSync(attachments, { throwIfNoEntry: false });
      if (attachmentStat?.isSymbolicLink()) {
        unlinkSync(attachments);
        orphanedFiles.push(attachments);
      } else if (attachmentStat?.isDirectory())
        scanAttachmentDirectory(attachments, expected, orphanedFiles);
    }
  }
  return { orphanedFiles, missingMetadata };
}

export function validateAttachmentStorageKey(value: string): string {
  return safeStorageKey(value);
}

export function validateAttachmentNamespaceId(value: string): string {
  return safeId(value, "Namespace ID");
}
